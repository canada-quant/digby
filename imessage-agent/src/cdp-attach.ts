/**
 * CDP-attach mode (feedback ticket 4258335e — 88915954 ask c, 2026-09-22).
 *
 * Lets the local browser destination run a task in the owner's EXISTING,
 * signed-in everyday Chrome instead of Digby's separate persistent profile —
 * the structural fix for anti-bot escalation against a fresh zero-history
 * profile (DataDome on CanLII, measured on the canlegal-bench harvest).
 *
 * OPT-IN ONLY — two off-by-default gates, BOTH required:
 *   1. Owner master switch: `browserCdpAttach: true` in
 *      ~/.config/digby-agent/config.json (or DIGBY_BROWSER_CDP_ATTACH=1).
 *      The Mac app has no native settings surface today; the friendly toggle
 *      is a follow-up writer of this same flag — the config file (chmod 600)
 *      is the owner-side switch v1 ships.
 *   2. Per-task: the backend sends `attach: true` on this session's browser_*
 *      commands (the browser_task tool's explicit per-task param — never a
 *      default, never sticky beyond one session).
 *
 * When both gates are set AND the owner's Chrome answers on
 * http://127.0.0.1:<port>/json/version (owner launches Chrome with
 * --remote-debugging-port=<port>, default 9222), browser.ts connects via
 * Playwright chromium.connectOverCDP and runs the task in a DEDICATED NEW TAB
 * of the owner's real profile. ANY failure (switch off, no Chrome on the port,
 * connect error) falls back to Digby's own profile — and every observation
 * reports the mode that ACTUALLY drove so the disclosure can never misname it.
 *
 * This module is deliberately PLAYWRIGHT-FREE (fetch + pure predicates) so the
 * node:test suite exercises the real logic without Playwright installed.
 */

import type { AgentConfig } from './config.js';

const envFlag = (name: string): boolean => /^(1|true|yes)$/i.test(process.env[name] || '');

export const DEFAULT_CDP_PORT = 9222;
/** Warn-only floor: Playwright 1.51's CDP speaks to any recent Chrome, but
 *  very old builds misbehave — log it, never block. */
export const MIN_ATTACH_CHROME_MAJOR = 120;

/** Gate 1 — the owner's master switch (config.json flag or env override). */
export function cdpAttachEnabled(config: Pick<AgentConfig, 'browserCdpAttach'> | null): boolean {
  if (envFlag('DIGBY_BROWSER_CDP_ATTACH')) return true;
  return config?.browserCdpAttach === true;
}

/** The owner's Chrome remote-debugging port (config > env > 9222). */
export function cdpPort(config: Pick<AgentConfig, 'browserCdpPort'> | null): number {
  const fromConfig = config?.browserCdpPort;
  if (typeof fromConfig === 'number' && Number.isFinite(fromConfig) && fromConfig > 0 && fromConfig < 65536) {
    return Math.floor(fromConfig);
  }
  const fromEnv = Number(process.env.DIGBY_BROWSER_CDP_PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) return Math.floor(fromEnv);
  return DEFAULT_CDP_PORT;
}

export interface CdpProbe {
  ok: boolean;
  /** e.g. "Chrome/131.0.6778.86" */
  browser?: string;
  chromeMajor?: number;
  webSocketDebuggerUrl?: string;
  error?: string;
}

/**
 * Probe the owner's Chrome remote-debugging endpoint: a 2s-bounded GET of
 * /json/version. Never throws — any failure is {ok:false} and the caller
 * falls back to Digby's own profile (graceful fallback, ticket question 4).
 */
export async function probeCdpEndpoint(
  port: number,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<CdpProbe> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 2000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: ctrl.signal } as RequestInit);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body: any = await res.json();
    const browser = typeof body?.Browser === 'string' ? body.Browser : undefined;
    const ws = typeof body?.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : undefined;
    if (!ws) return { ok: false, error: 'no webSocketDebuggerUrl (not a Chrome DevTools endpoint?)' };
    const majorMatch = browser?.match(/(\d+)\./);
    return {
      ok: true,
      browser,
      chromeMajor: majorMatch ? Number(majorMatch[1]) : undefined,
      webSocketDebuggerUrl: ws,
    };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.name === 'AbortError' ? `no answer within ${timeoutMs}ms` : (e?.message || String(e)),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Safety rails (attached mode only) ────────────────────────────────────────
//
// In the owner's EVERYDAY Chrome the blast radius of a wrong action is their
// real logged-in accounts. The owner runs Digby under a standing no-confirm
// autonomy directive (computer-loop.ts header), so these rails are HARD
// REFUSALS — never confirmation gates (ticket question 2):
//   - typing into password / credential fields
//   - submitting forms (submit buttons, or Enter-to-submit via type)
// Everything else — navigate/read/scroll/screenshot, clicking links and
// non-submit buttons, typing into ordinary fields — runs normally; the
// per-action observation stream remains the audit trail.

export interface ElementAttrs {
  tag: string;
  type?: string;
  autocomplete?: string;
  name?: string;
  id?: string;
  placeholder?: string;
  role?: string;
  text?: string;
  insideForm?: boolean;
}

const CREDENTIAL_RE =
  /pass(word)?|passwd|credential|totp|otp|2fa|mfa|cvv|cvc|card[-_ ]?num|security[-_ ]?code|\bssn\b/i;

const SUBMIT_TEXT_RE =
  /^(sign|log)[ -]?(in|out|up)$|^(create account|continue|submit|send|post|pay|purchase|check[ -]?out|place order|confirm|delete|remove|transfer|buy|book|subscribe|save|publish|tweet)$/i;

/**
 * Classify a resolved DOM element for the attach-mode rails: 'credential'
 * (never type into it) or 'submit' (never click it), else null. Pure and
 * exported for the node:test suite.
 */
export function classifyElement(attrs: ElementAttrs): 'credential' | 'submit' | null {
  const type = (attrs.type || '').toLowerCase();
  const autocomplete = (attrs.autocomplete || '').toLowerCase();
  const ident = `${attrs.name || ''} ${attrs.id || ''} ${attrs.placeholder || ''}`;
  if (
    type === 'password' ||
    autocomplete === 'current-password' ||
    autocomplete === 'new-password' ||
    autocomplete === 'one-time-code' ||
    CREDENTIAL_RE.test(ident)
  ) {
    return 'credential';
  }
  const tag = (attrs.tag || '').toLowerCase();
  if (tag === 'input' && (type === 'submit' || type === 'image')) return 'submit';
  if (tag === 'button' && type === 'submit') return 'submit';
  // A <button> without an explicit type inside a form IS a submit button (HTML spec).
  if (tag === 'button' && !type && attrs.insideForm) return 'submit';
  const role = (attrs.role || '').toLowerCase();
  if (role === 'button' && SUBMIT_TEXT_RE.test((attrs.text || '').trim())) return 'submit';
  return null;
}

export const ATTACH_REFUSAL_CREDENTIAL =
  'REFUSED (CDP-attach safety rail): Digby never types into password/credential fields in your everyday Chrome — complete that step by hand.';

export const ATTACH_REFUSAL_SUBMIT =
  'REFUSED (CDP-attach safety rail): Digby never submits forms in your everyday Chrome — review the page and press the button yourself.';

export const ATTACH_REFUSAL_SUBMIT_KEY =
  'REFUSED (CDP-attach safety rail): pressing Enter to submit is disabled in your everyday Chrome — review the page and submit it yourself.';
