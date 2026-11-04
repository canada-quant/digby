/**
 * HostedBrowserDriver (ticket ea3ad8a8) — the hosted hardened browser: a
 * pinned-Chromium container with ONE persistent context per session (own
 * cookies/localStorage/cache, state persisted to disk). For users with NO
 * paired Mac/Windows desktop agent — the "saved cache / VM-style" browser.
 *
 * The driver speaks the same action vocabulary as cloud/local via the pure-HTTP
 * client (session-browser-client.ts). Interactive by design: clicks and typing
 * work (it is a real Chromium in a container, not a scrape proxy) — the
 * interaction ceiling is 'cdp'-equivalent ('cdp' is BrightData-specific
 * vocabulary for "live session" — reuse it rather than widen the union, so the
 * glm-loop's existing capability plumbing applies unchanged).
 */

import logger from '../../../utils/logger';
import { BrowserAction, BrowserDriver, BrowserObservation, LiveViewFrame } from './types';
import {
  sessionBrowserAction,
  sessionBrowserAvailable,
  sessionBrowserClose,
} from './session-browser-client';

const MAX_CONTENT_CHARS = 8000;

function clip(s: string): { content: string; truncated: boolean } {
  if (s.length <= MAX_CONTENT_CHARS) return { content: s, truncated: false };
  return { content: s.slice(0, MAX_CONTENT_CHARS) + '\n…[truncated]', truncated: true };
}

export class HostedBrowserDriver implements BrowserDriver {
  readonly kind = 'hosted' as const;

  constructor(
    private readonly sessionKey: string,
    private readonly opts: { closeOnFinish?: boolean } = {},
  ) {
    // BrowserDriver.kind is 'cloud' | 'local' today; the union is widened in
    // types.ts to include 'hosted'. `as const` keeps this literal assignable.
  }

  async isAvailable(): Promise<boolean> {
    return sessionBrowserAvailable(this.sessionKey);
  }

  async execute(action: BrowserAction): Promise<BrowserObservation> {
    const res = await sessionBrowserAction(this.sessionKey, {
      name: action.name,
      url: action.url,
      format: action.format,
      selector: action.selector,
      text: action.text,
      submit: action.submit,
      direction: action.direction,
      amount: action.amount,
      reasoning: action.reasoning,
    });
    const obs: BrowserObservation = {
      ok: res.ok,
      driver: 'hosted',
      action: (res.action as BrowserAction['name']) || action.name,
      url: res.url,
      content: res.content,
      links: res.links,
      error: res.error,
      truncated: res.truncated,
      screenshotBase64: res.screenshotBase64,
      screenshotMime: res.screenshotBase64 ? 'image/png' : undefined,
    };
    return obs;
  }

  async close(): Promise<void> {
    // Keep the context alive by default: persistence IS the feature (saved
    // cookies/cache resume next time). Only close when the caller asked.
    if (this.opts.closeOnFinish) {
      await sessionBrowserClose(this.sessionKey);
    } else {
      logger.debug(`hosted browser: keeping context alive for ${this.sessionKey} (persistent by design)`);
    }
  }

  /** Always interactive — a real Chromium. */
  interactionCapability(): 'cdp' {
    return 'cdp';
  }

  async liveView(): Promise<LiveViewFrame | null> {
    const res = await sessionBrowserAction(this.sessionKey, { name: 'screenshot' }, 30_000);
    if (!res.ok || !res.screenshotBase64) return null;
    return { screenshotBase64: res.screenshotBase64, mime: 'image/png', url: res.url };
  }

  wasInteractiveRefused(): boolean {
    return false; // never refused while the service is up
  }
}
