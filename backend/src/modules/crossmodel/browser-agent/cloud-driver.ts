/**
 * CloudBrowserDriver — the official BrightData browser via the Digby MCP gateway.
 *
 * The gateway (mcp.digby.ai) runs @brightdata/mcp (PRO_MODE) and exposes the full
 * scraping_browser_* suite (navigate / snapshot / click_ref / type_ref / get_text /
 * get_html / scroll / screenshot) plus scrape_as_markdown / scrape_as_html.
 *
 * This driver uses the REAL BrightData Scraping Browser when it can connect:
 *   navigate → scraping_browser_navigate; read → scraping_browser_get_text /
 *   _get_html; map → scraping_browser_snapshot (returns element refs); interact →
 *   scraping_browser_click_ref / _type_ref / _scroll (ref-based, refs come from a
 *   snapshot). Full navigate/click/type/scroll.
 *
 * Auto-fallback: the Scraping Browser is a CDP session at brd.superproxy.io:9222.
 * If that connection is refused (today it returns 407 ip_forbidden because the prod
 * server's IP isn't on the BrightData zone's allowlist — fix: allowlist the IP or
 * disable the zone's IP-whitelist), the driver drops to a read-only scrape mode
 * (scrape_as_markdown) so navigate/read still work; interactive actions then report
 * that a live session wasn't available (and the router prefers the local Mac browser
 * for interaction anyway). The instant the zone is allowlisted, navigate connects
 * and the real browser is used — no code change.
 *
 * Interaction capability states (interactionCapability(), feedback c3c06260):
 *   - 'cdp'                — a live interactive CDP session is up: clicks/typing work.
 *   - 'zone-blocked'       — a CDP attempt returned a BrightData zone-block signature
 *                            (407 ip_forbidden / auth failure): the zone is rejecting
 *                            this server's egress IP; read-only until allowlisted.
 *   - 'disabled-by-config' — CLOUD_BROWSER_CDP is off (the prod default): CDP is never
 *                            attempted, so EVERY cloud session is read-only from the
 *                            start. Knowable before the first navigate — the glm-loop
 *                            uses it to plan read-only from step 0.
 *   - 'unavailable'        — CDP is enabled but the session failed for a non-zone
 *                            reason (e.g. the gateway swallowed the error into a
 *                            null result): transient, not a hard block.
 * The refusal message the model sees (readOnlyMsg) names the actual cause instead
 * of always blaming the zone — 'disabled-by-config' sessions are misdiagnosed
 * without it (the calling agent used to discover read-only mode only from
 * sub-agent narration several steps in).
 */

import logger from '../../../utils/logger';
import { callMcpTool, mcpBrowserGatewayTarget } from '../mcp-search';
import { directScreenshotPng } from '../brightdata-direct';
import { mcpSessions, browserMcpSessionKey } from '../mcp-session';
import { BrowserAction, BrowserDriver, BrowserInteractionCapability, BrowserObservation, LiveViewFrame } from './types';
import { webSearchStatus, webSearchProblemSuffix } from '../platform/instance-setup';

const MAX_CONTENT_CHARS = 8000;   // cap page text fed back to the model per step
const SCRAPE_TIMEOUT_MS = 45000;  // BrightData scrape can exceed the default 30s
// The BrightData Scraping Browser launches a real cloud Chrome session; the first
// navigate (cold start) routinely takes 30-45s, so give it generous headroom or we
// time out and needlessly fall back to scrape. Warm ops (read/interact) are faster.
const CDP_NAV_TIMEOUT_MS = 90000; // scraping_browser_navigate (session launch + nav)
const CDP_TIMEOUT_MS = 60000;     // warm Scraping Browser ops (read / snapshot / interact)
// The interactive Scraping Browser (scraping_browser_*) needs a PERSISTENT browser
// session across calls (navigate → snapshot → click → read). The Digby MCP gateway
// (supergateway) currently serves each tools/call independently, so multi-step CDP
// sessions don't persist (navigate succeeds, but the next call sees a blank/closed
// page → "Error capturing ARIA snapshot"). Until the gateway is made session-stateful,
// default to the reliable one-shot scrape path; flip CLOUD_BROWSER_CDP=1 to use the
// ref-based interactive browser once the gateway preserves sessions.
const CLOUD_BROWSER_CDP = /^(1|true|yes)$/i.test(process.env.CLOUD_BROWSER_CDP || '');

function asText(raw: any): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  try { return JSON.stringify(raw); } catch { return String(raw); }
}

/** True when a scraping_browser_* call did not yield a live CDP session. */
function cdpUnavailable(raw: any): boolean {
  if (raw == null) return true;
  return /execution failed|connectOverCDP|WebSocket error|ip_forbidden|Auth Failed/i.test(asText(raw));
}

/**
 * BrightData ZONE-BLOCK signature — a CDP attempt rejected because this server's
 * egress IP is not on the Scraping Browser zone's IP allowlist. Deliberately does
 * NOT match a bare "407": page content can carry that number (feedback c3c06260).
 */
const ZONE_BLOCK_RE = /ip_forbidden|auth failed|proxy authentication/i;

/** True when a CDP call returned non-null TEXT matching the zone-block signature. */
function isZoneBlockText(raw: any): boolean {
  return raw != null && ZONE_BLOCK_RE.test(asText(raw));
}

function clip(s: string | undefined): { content: string; truncated: boolean } {
  const text = s || '';
  if (text.length <= MAX_CONTENT_CHARS) return { content: text, truncated: false };
  return { content: text.slice(0, MAX_CONTENT_CHARS) + '\n…[truncated]', truncated: true };
}

/** Pull markdown links ([text](url)) out of scraped content (read-only fallback). */
function extractLinks(markdown: string): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = [];
  const re = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) && out.length < 50) {
    const text = m[1].trim();
    if (text) out.push({ text, href: m[2] });
  }
  return out;
}

/** Why an interactive action was refused — interactionCapability() minus 'cdp'. */
type InteractionCause = Exclude<BrowserInteractionCapability, 'cdp'>;

/**
 * The read-only refusal the model sees — cause-AWARE (feedback c3c06260): the old
 * text always blamed a BrightData zone-block, so the default prod config (CDP off)
 * was systematically misdiagnosed by the driving model and the calling agent.
 */
function readOnlyMsg(action: string, cause: InteractionCause): string {
  const causeSentence =
    cause === 'zone-blocked'
      ? "the BrightData Scraping Browser zone is blocking this server's egress IP (407 ip_forbidden) — it must be added to the zone's IP allowlist before clicks/typing work"
      : cause === 'disabled-by-config'
        ? 'interactive cloud browsing is disabled on this server (CLOUD_BROWSER_CDP off — the MCP gateway cannot hold a live browser session between calls)'
        : 'no live interactive browser session could be established (transient gateway/upstream error)';
  return (
    `The cloud browser could not open a live interactive session (${causeSentence}), so it is reading pages and ` +
    `cannot ${action}. Follow a link by navigating to its URL; tasks needing clicks, ` +
    `typing, or a logged-in session are better on the user's local Mac browser.`
  );
}

export class CloudBrowserDriver implements BrowserDriver {
  readonly kind = 'cloud' as const;
  private mode: 'unknown' | 'cdp' | 'scrape' = 'unknown';
  private currentUrl = '';
  private lastContent = '';
  /**
   * THIS run's gateway MCP session key (ticket 5f69fdc4). The gateway holds one
   * stdio child — and therefore ONE BrightData browser — per Mcp-Session-Id, so
   * a private key here is what makes `navigate → snapshot → get_text →
   * click_ref` hit the same page. A per-instance key (never a shared constant)
   * keeps two concurrent runs from fighting over one page.
   */
  private readonly mcpSessionKey = browserMcpSessionKey();
  /** ref → the snapshot line's human description (BrightData's required `element`). */
  private refDescriptions = new Map<string, string>();
  /** URL of the last live-view render — the cloud page is a static fetch, so
   *  re-rendering the same URL on every get_content would only burn unlocker
   *  requests and time. */
  private liveViewUrl = '';

  async isAvailable(): Promise<boolean> {
    return true; // always-available fallback driver
  }

  /**
   * True once an INTERACTIVE action (click/type/scroll/screenshot) was refused
   * because there is no live CDP session. This is config-independent: it fires
   * both on a mid-session BrightData zone-block (CDP dropped to scrape) AND in
   * the default prod config where CLOUD_BROWSER_CDP is unset and every cloud
   * session is read-only from the start (PR #293 review: a mode==='scrape'
   * check is inert in that config, and a read-only NAVIGATE alone must not
   * reroute — pure-read tasks work fine on scrape). The glm-loop watches this
   * to fall back to the user's paired Mac browser (feedback b346ce80).
   */
  wasInteractiveRefused(): boolean {
    return this.interactiveRefused;
  }

  /** Set by the interactive handlers when they refuse without a CDP session. */
  private interactiveRefused = false;

  /**
   * Set when a CDP attempt returned the BrightData zone-block signature
   * (407 ip_forbidden / auth failure) — at navigate (first refusal) or mid-session
   * from an interactive handler (feedback c3c06260).
   */
  private zoneBlocked = false;

  /**
   * The CURRENT interaction ceiling (feedback c3c06260). 'disabled-by-config' is
   * knowable BEFORE any navigate (CDP is never attempted when the flag is off) —
   * the glm-loop reads it eagerly to plan read-only from step 0 and to name the
   * real cause at the tool-result surface.
   */
  interactionCapability(): BrowserInteractionCapability {
    // A zone-block seen at ANY point (first navigate OR mid-session from an
    // interactive handler) sticks until a CDP navigate proves the zone lets us
    // through again — checked BEFORE 'cdp' so a mid-session block (live CDP
    // session drops after a successful navigate) still surfaces a
    // capabilityNotice instead of ending the session as a false 'cdp'
    // (adversarial-review F1, feedback c3c06260).
    if (this.zoneBlocked) return 'zone-blocked';
    if (this.mode === 'cdp') return 'cdp';
    if (!CLOUD_BROWSER_CDP) return 'disabled-by-config';
    return 'unavailable';
  }

  /** Cause wording for read-only refusals — only called when mode !== 'cdp'. */
  private refusalCause(): InteractionCause {
    const cap = this.interactionCapability();
    return cap === 'cdp' ? 'unavailable' : cap;
  }

  async execute(action: BrowserAction): Promise<BrowserObservation> {
    try {
      switch (action.name) {
        case 'navigate':
          return await this.navigate(action.url || '');
        case 'get_content':
          return await this.getContent(action.format || 'text');
        case 'extract':
          return await this.getContent('text');
        case 'click':
          return await this.click(action.ref || action.selector || '', action.element);
        case 'type':
          return await this.type(action.ref || action.selector || '', action.text || '', action.element, action.submit);
        case 'scroll':
          return await this.scroll(action.direction || 'down', action.amount);
        case 'screenshot':
          return await this.screenshot();
        default:
          return this.fail(action.name, `Unsupported cloud action: ${action.name}`);
      }
    } catch (e: any) {
      return this.fail(action.name, e?.message || String(e));
    }
  }

  private fail(action: any, error: string): BrowserObservation {
    return { ok: false, driver: 'cloud', action, error };
  }

  // ── navigate: try the real Scraping Browser; fall back to scrape on CDP refusal ──
  private async navigate(url: string): Promise<BrowserObservation> {
    if (!url) return this.fail('navigate', 'navigate requires a url');
    this.currentUrl = url;
    // A navigation invalidates the previous document's refs (BrightData resolves
    // refs against the CURRENT page), so the cached descriptions go with it.
    this.refDescriptions.clear();

    if (CLOUD_BROWSER_CDP && this.mode !== 'scrape') {
      const res = await this.cdp('scraping_browser_navigate', { url }, CDP_NAV_TIMEOUT_MS);
      if (!cdpUnavailable(res)) {
        this.mode = 'cdp';
        this.zoneBlocked = false; // a live CDP session disproves an earlier block (review F1)
        const text = asText(await this.cdp('scraping_browser_get_text', {}, CDP_TIMEOUT_MS));
        // 5f69fdc4 (2026-11-03): an EMPTY CDP read is NOT a successful
        // navigation. Before this guard the driver returned ok:true with
        // content '' whenever get_text yielded nothing, so an interactive
        // session could silently serve a blank page and the caller had no way
        // to tell it apart from a genuinely empty document. Fall through to
        // the scrape path instead: it is the proven rendered-content path
        // (criterion 5), so the worst case becomes a slower answer, never a
        // blank one.
        if (text.trim()) {
          this.lastContent = text;
          const { content, truncated } = clip(text);
          return { ok: true, driver: 'cloud', action: 'navigate', url, content, truncated };
        }
        logger.warn(
          'CloudBrowserDriver: CDP navigate returned EMPTY page text → falling back to the scrape path (never ok:true with 0 bytes)',
        );
      }
      // A non-null zone-block TEXT names the cause (a swallowed null stays ambiguous
      // — capability 'unavailable', not 'zone-blocked'; feedback c3c06260).
      if (isZoneBlockText(res)) this.zoneBlocked = true;
      if (this.mode === 'unknown') {
        this.mode = 'scrape';
        logger.warn('CloudBrowserDriver: BrightData Scraping Browser CDP unavailable (ip_forbidden?) → read-only scrape mode');
      }
    }
    return this.scrapeNavigate(url);
  }

  private async scrapeNavigate(url: string): Promise<BrowserObservation> {
    const md = await callMcpTool('scrape_as_markdown', { url }, SCRAPE_TIMEOUT_MS);
    if (!md || typeof md !== 'string') {
      // Self-host setup hardening (2026-10-20): the cloud reader IS the scrape
      // tier — on an instance with no search backend nothing can be loaded.
      return this.fail('navigate', webSearchStatus().configured
        ? `Could not load ${url} (the page may be slow, blocked, or down — try another URL).`
        : `Could not load ${url}: web page fetching is not configured on this Digby instance (no BrightData token or MCP gateway), so the cloud reader cannot run here.${webSearchProblemSuffix()} An admin enables web search under Account → Admin → Setup; a paired Mac or the hosted browser service are the other destinations.`);
    }
    this.lastContent = md;
    const { content, truncated } = clip(md);
    return { ok: true, driver: 'cloud', action: 'navigate', url, content, truncated };
  }

  // ── read ──────────────────────────────────────────────────────────────────────
  private async getContent(format: 'text' | 'html' | 'snapshot'): Promise<BrowserObservation> {
    if (this.mode === 'cdp') {
      const tool = format === 'html' ? 'scraping_browser_get_html'
        : format === 'snapshot' ? 'scraping_browser_snapshot'
        : 'scraping_browser_get_text';
      const out = asText(await this.cdp(tool, {}, CDP_TIMEOUT_MS));
      if (!out || cdpUnavailable(out)) return this.fail('get_content', `Could not read the page (${format}).`);
      if (format !== 'html') this.lastContent = out;
      // A snapshot carries the element refs the model needs AND their human
      // descriptions — keep them so click/type can supply BrightData's required
      // `element` without asking the model to retype it (ticket 5f69fdc4).
      if (format === 'snapshot') this.indexSnapshotRefs(out);
      const { content, truncated } = clip(out);
      // For a snapshot, the content itself carries the element refs the model needs.
      return { ok: true, driver: 'cloud', action: 'get_content', url: this.currentUrl, content, truncated };
    }

    // read-only scrape mode
    if (format === 'html') {
      const html = await callMcpTool('scrape_as_html', { url: this.currentUrl }, SCRAPE_TIMEOUT_MS);
      if (html && typeof html === 'string') {
        const { content, truncated } = clip(html);
        return { ok: true, driver: 'cloud', action: 'get_content', url: this.currentUrl, content, truncated };
      }
    }
    let md = this.lastContent;
    if (!md && this.currentUrl) {
      md = (await callMcpTool('scrape_as_markdown', { url: this.currentUrl }, SCRAPE_TIMEOUT_MS)) || '';
      this.lastContent = md;
    }
    if (!md) return this.fail('get_content', 'No page loaded yet — navigate to a URL first.');
    const { content, truncated } = clip(md);
    if (format === 'snapshot') {
      return { ok: true, driver: 'cloud', action: 'get_content', url: this.currentUrl, content, truncated, links: extractLinks(md) };
    }
    return { ok: true, driver: 'cloud', action: 'get_content', url: this.currentUrl, content, truncated };
  }

  // ── interact (ref-based, real Scraping Browser only) ────────────────────────────
  private async click(ref: string, element?: string): Promise<BrowserObservation> {
    if (this.mode !== 'cdp') { this.interactiveRefused = true; return this.fail('click', readOnlyMsg('click', this.refusalCause())); }
    if (!ref) return this.fail('click', 'click needs an element ref — call get_content with format="snapshot" first to get refs.');
    // `element` is REQUIRED by BrightData's zod schema (no default): omitting it
    // is a -32602 parameter-validation error and NO click happens. It is only a
    // human-readable label — the target resolves from `ref` alone — so the
    // snapshot's own description, then the ref itself, are safe fallbacks.
    const res = await this.cdp('scraping_browser_click_ref', { ref, element: this.elementFor(ref, element) }, CDP_TIMEOUT_MS);
    if (isZoneBlockText(res)) this.zoneBlocked = true; // mid-session block (c3c06260)
    if (cdpUnavailable(res)) return this.fail('click', asText(res).slice(0, 160) || 'click failed');
    return { ok: true, driver: 'cloud', action: 'click', url: this.currentUrl };
  }

  private async type(ref: string, text: string, element?: string, submit?: boolean): Promise<BrowserObservation> {
    if (this.mode !== 'cdp') { this.interactiveRefused = true; return this.fail('type', readOnlyMsg('type', this.refusalCause())); }
    if (!ref) return this.fail('type', 'type needs an element ref — call get_content with format="snapshot" first to get refs.');
    const res = await this.cdp(
      'scraping_browser_type_ref',
      { ref, element: this.elementFor(ref, element), text, ...(submit ? { submit: true } : {}) },
      CDP_TIMEOUT_MS,
    );
    if (isZoneBlockText(res)) this.zoneBlocked = true; // mid-session block (c3c06260)
    if (cdpUnavailable(res)) return this.fail('type', asText(res).slice(0, 160) || 'type failed');
    return { ok: true, driver: 'cloud', action: 'type', url: this.currentUrl };
  }

  // ── MCP wire session (ticket 5f69fdc4) ──────────────────────────────────────
  /**
   * Every `scraping_browser_*` call rides THIS driver's own gateway session on
   * the STATEFUL mount, so navigate → snapshot → get_text → click_ref reach the
   * SAME BrightData browser. Without either half the gateway hands each
   * tools/call a fresh stdio child — hence a fresh browser — and a successful
   * navigate is followed by a snapshot of "Page: about:blank" (measured).
   */
  private cdp(toolName: string, args: Record<string, any>, timeoutMs: number): Promise<any> {
    return callMcpTool(toolName, args, timeoutMs, {
      sessionKey: this.mcpSessionKey,
      gatewayUrl: mcpBrowserGatewayTarget().url,
    });
  }

  /**
   * The `element` label for a ref: the caller's own description wins (it may be
   * richer than the snapshot's), then the snapshot line's description, then the
   * ref. Never empty — an empty string would still satisfy zod but produce
   * useless error text, and `undefined` would be a hard -32602.
   */
  private elementFor(ref: string, provided?: string): string {
    const own = (provided || '').trim();
    if (own) return own;
    const fromSnapshot = (this.refDescriptions.get(ref) || '').trim();
    if (fromSnapshot) return fromSnapshot;
    return ref;
  }

  /**
   * Index a snapshot's `ref → human description` pairs so click/type can supply
   * BrightData's required `element` without the model having to retype it.
   * Handles BOTH body variants `@brightdata/mcp` emits:
   *   full     `- button "Submit" [ref=e8]`
   *   filtered `[e8] button "Submit" -> https://…`
   * A line matching neither is skipped — a parse miss only costs a fallback
   * label (the ref itself), never a failed action.
   */
  private indexSnapshotRefs(snapshot: string): void {
    for (const line of (snapshot || '').split('\n')) {
      const full = /^-\s+(\S+)\s+"([^"]*)"(.*)\[ref=([^\]]+)\]/.exec(line);
      if (full) {
        const [, role, name, , ref] = full;
        const desc = name.trim() ? `${role} "${name.trim()}"` : role;
        this.refDescriptions.set(ref.trim(), desc);
        continue;
      }
      const compact = /^\[([^\]]+)\]\s+(\S+)\s+"([^"]*)"/.exec(line.trim());
      if (compact) {
        const [, ref, role, name] = compact;
        const desc = name.trim() ? `${role} "${name.trim()}"` : role;
        this.refDescriptions.set(ref.trim(), desc);
      }
    }
  }

  private async scroll(direction: string, amount?: number): Promise<BrowserObservation> {
    if (this.mode !== 'cdp') { this.interactiveRefused = true; return this.fail('scroll', readOnlyMsg('scroll', this.refusalCause())); }
    // MUST ride `this.cdp()` (ticket bbe53f95). Calling `callMcpTool` directly
    // drops BOTH halves of the wire-session contract — `sessionKey` and the
    // stateful `gatewayUrl` — so the call lands on the SHARED STATELESS `/mcp`
    // mount, gets its own fresh stdio child (hence its own blank browser) and
    // scrolls a page nobody is looking at. Measured on prod box A with
    // CLOUD_BROWSER_CDP=1: open ok/1565 B and follow-link ok, but scroll hung
    // 75 s to the 60 s SSE cap, while the SAME call hand-rolled onto the
    // session answered in 380 ms. Every interactive action must go through
    // `this.cdp()`.
    const res = await this.cdp('scraping_browser_scroll', { direction, ...(amount ? { pixels: amount } : {}) }, CDP_TIMEOUT_MS);
    if (isZoneBlockText(res)) this.zoneBlocked = true; // mid-session block (c3c06260)
    return { ok: !cdpUnavailable(res), driver: 'cloud', action: 'scroll', url: this.currentUrl };
  }

  private async screenshot(): Promise<BrowserObservation> {
    if (this.mode !== 'cdp') { this.interactiveRefused = true; return this.fail('screenshot', readOnlyMsg('screenshot', this.refusalCause())); }
    // `this.cdp()` — same session contract as scroll (ticket bbe53f95).
    const raw = await this.cdp('scraping_browser_screenshot', {}, CDP_TIMEOUT_MS);
    if (isZoneBlockText(raw)) this.zoneBlocked = true; // mid-session block (c3c06260)
    const b64 = typeof raw === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(raw.slice(0, 64)) ? raw.replace(/\s+/g, '') : undefined;
    if (cdpUnavailable(raw) && !b64) return this.fail('screenshot', 'screenshot unavailable');
    return { ok: true, driver: 'cloud', action: 'screenshot', url: this.currentUrl, screenshotBase64: b64 };
  }

  /**
   * Live view for the browser panel (2026-09-09). The default cloud mode is a
   * stateless markdown scrape — there are no pixels to show — so the panel
   * rendered "text mode, no visual preview" for EVERY cloud browse. Now: with a
   * live CDP session, a real `scraping_browser_screenshot`; otherwise the
   * Web Unlocker renders the current URL to PNG (data_format: screenshot). One
   * render per URL; best-effort null on any failure.
   */
  async liveView(): Promise<LiveViewFrame | null> {
    const url = this.currentUrl;
    if (!url || url === this.liveViewUrl) return null;
    try {
      if (this.mode === 'cdp') {
        // `this.cdp()` — a live-view render of the SESSION's page. On the
        // stateless mount this screenshots a throwaway browser (or times out),
        // so the panel showed nothing even with CDP on (ticket bbe53f95).
        const raw = await this.cdp('scraping_browser_screenshot', {}, CDP_TIMEOUT_MS);
        const b64 = typeof raw === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(raw.slice(0, 64)) ? raw.replace(/\s+/g, '') : undefined;
        if (!b64) return null;
        this.liveViewUrl = url;
        return { screenshotBase64: b64, mime: 'image/png', url };
      }
      const png = await directScreenshotPng(url);
      if (!png) return null;
      this.liveViewUrl = url;
      return { screenshotBase64: png, mime: 'image/png', url };
    } catch (e: any) {
      logger.info(`CloudBrowserDriver: live-view render skipped for ${url.slice(0, 60)}: ${e?.message || e}`);
      return null;
    }
  }

  async close(): Promise<void> {
    // Release this run's gateway session: supergateway stops that session's
    // stdio child, which is what actually closes the BrightData browser. Left
    // alone a run's cloud browser lingers until the gateway's 30-min idle
    // reaper — the exact context leak the (d) probe discipline forbids.
    // scrape mode holds no session, so release() is a no-op there.
    try {
      // The session was MINTED on the stateful browser mount, so it must be
      // torn down there (ticket 5f69fdc4 follow-up). Handing `release()` the
      // shared stateless target pointed the DELETE at a gateway that never
      // held the id; the stdio child — and the BrightData browser behind it —
      // survived until the 30-min idle reaper.
      await mcpSessions.release(this.mcpSessionKey, mcpBrowserGatewayTarget());
    } catch (e: any) {
      logger.info(`CloudBrowserDriver: session release skipped: ${e?.message || e}`);
    }
    this.refDescriptions.clear();
  }
}
