/**
 * Browser Agent — shared types
 *
 * Digby's browser-use feature. GLM-5.3 (open-source, reasoning_effort:"high") drives
 * a real web browser through a small, driver-agnostic action vocabulary. Two drivers
 * implement that vocabulary:
 *   - CloudBrowserDriver — BrightData's cloud scraping browser via the Digby MCP
 *     gateway (browser_* tools). Always available; great for public web + anti-bot.
 *   - LocalBrowserDriver — the user's own Mac, via the paired Digby iMessage agent
 *     (Playwright). Runs Digby's OWN persistent browser profile on that Mac —
 *     logged in wherever the user signed in THROUGH Digby before; it is NOT the
 *     user's everyday Chrome/Safari profile.
 *   - (handoff) the computer agent — the user's REAL desktop: their actual browser
 *     with its existing logins, Mail, Finder, any installed app, driven by
 *     screenshots + clicks/keys (computer-agent/). The router can pick it as a
 *     third destination (kind 'computer'); the glm-loop hands the task over.
 *
 * The router REASONS (no hardcoded trigger words) about which driver fits the task
 * given the drivers actually available to this user.
 */

/** The driver-agnostic browser action vocabulary GLM-5.3 is given as tools. */
export type BrowserActionName =
  | 'navigate'
  | 'get_content'
  | 'click'
  | 'type'
  | 'scroll'
  | 'screenshot'
  | 'extract'
  | 'ask_user'
  | 'done';

export interface BrowserAction {
  name: BrowserActionName;
  /** navigate */
  url?: string;
  /** get_content / extract */
  format?: 'text' | 'html' | 'snapshot';
  /** click / type / scroll target (local Playwright driver: CSS/text selector) */
  selector?: string;
  /** click / type target on the cloud BrightData browser: an element ref from a snapshot (e.g. "e12") */
  ref?: string;
  /**
   * Human-readable description of the element a cloud `click`/`type` targets —
   * the text after the role in a snapshot line (`- button "Submit" [ref=e8]`
   * → `Submit`). BrightData's MCP tools REQUIRE it (`element` is in their zod
   * schema with no default: omitting it is a -32602 parameter-validation error
   * and no click happens — ticket 5f69fdc4). It is only a label: the browser
   * resolves the target from `ref` alone. The cloud driver falls back to the
   * snapshot's own description for that ref, then to the ref itself, so the
   * param is never absent.
   */
  element?: string;
  /** type */
  text?: string;
  /** type — press Enter after typing (e.g. submit a search box) */
  submit?: boolean;
  /** scroll */
  direction?: 'up' | 'down' | 'top' | 'bottom';
  amount?: number;
  /** extract — what to pull out of the page */
  instruction?: string;
  /** ask_user / done — message/answer to the user */
  message?: string;
  /** the model's own short rationale for this step (shown to the user for transparency) */
  reasoning?: string;
}

export interface BrowserObservation {
  ok: boolean;
  driver: 'cloud' | 'local' | 'hosted';
  action: BrowserActionName;
  /** current page URL after the action, when known */
  url?: string;
  /** text / html / extracted content returned by the action */
  content?: string;
  /** base64 image (screenshot action) — PNG unless screenshotMime says otherwise */
  screenshotBase64?: string;
  /** MIME of screenshotBase64 when the driver knows it (agent ≥ 0.4.1 returns
   *  JPEG for live-view captures); absent = PNG. */
  screenshotMime?: string;
  /** links discovered (snapshot/get_content), kept compact for the model */
  links?: Array<{ text: string; href: string }>;
  error?: string;
  /** true when content was clipped to fit the model context */
  truncated?: boolean;
  /** LOCAL driver only (agent ≥ 0.5.0, ticket 4258335e): which browser
   *  ACTUALLY drove this action — 'attached' = a dedicated new tab of the
   *  user's everyday Chrome (CDP attach); 'digby-profile' = Digby's own
   *  persistent profile (the default and the attach fallback). The disclosure
   *  wording branches on the ACTUAL mode, never on what was requested. */
  mode?: 'digby-profile' | 'attached';
}

/** Actions that mutate page/site state — surfaced to the UI for transparency. */
export const STATE_CHANGING_ACTIONS: Set<BrowserActionName> = new Set(['click', 'type']);

/**
 * A driver's CURRENT interaction ceiling (feedback c3c06260):
 *   - 'cdp'               — fully interactive live session (click/type/scroll/screenshot work)
 *   - 'zone-blocked'      — the cloud BrightData zone rejected this server's egress IP
 *   - 'disabled-by-config'— interactive mode is off by server config (knowable BEFORE
 *                           the first navigate — the eager read-only signal)
 *   - 'unavailable'       — interaction failed for a transient/non-zone reason
 */
export type BrowserInteractionCapability = 'cdp' | 'zone-blocked' | 'disabled-by-config' | 'unavailable';

/** A driver executes the action vocabulary against some browser backend. */
export interface BrowserDriver {
  readonly kind: 'cloud' | 'local' | 'hosted';
  /** Cheap liveness/capability check. */
  isAvailable(): Promise<boolean>;
  execute(action: BrowserAction): Promise<BrowserObservation>;
  /** Best-effort cleanup (close the remote/local browser session). */
  close(): Promise<void>;
  /**
   * True once an INTERACTIVE action (click/type/scroll/screenshot) was refused
   * because the driver has no live interactive session (a capability limit, not
   * a page error). The glm-loop watches this to re-route to a fallback driver.
   * Optional — drivers that are always fully interactive omit it.
   */
  wasInteractiveRefused?(): boolean;
  /**
   * CDP-attach (4258335e): why a requested attach will NOT be honored (agent
   * too old / unknown version) — surfaced in the session's localBrowserStatus.
   * Null when attach runs or was never requested. Only the local driver
   * implements it.
   */
  attachNote?(): string | null;
  /**
   * The driver's CURRENT interaction ceiling — see BrowserInteractionCapability.
   * Optional; when present the glm-loop surfaces a hard capability notice at the
   * end of any session whose final driver cannot interact.
   */
  interactionCapability?(): BrowserInteractionCapability;
  /**
   * Headed escalation (UI Phase 6b): make the live page VISIBLE to the user so
   * they can act on it by hand (login/2FA). The local Mac driver relaunches its
   * headless-by-default browser HEADED on the same persistent profile with the
   * current URL restored (agent v0.4.0+). Best-effort and additive: resolves
   * false — never throws — when the driver/agent cannot comply (old agent,
   * env-forced headless, no live page). Only the local driver implements it.
   */
  popOutHeaded?(): Promise<boolean>;
  /**
   * Live view (2026-09-09 — owner: "why don't we have the visual showing as the
   * browser actions occur?"): a screenshot of the CURRENT page taken purely for
   * the UI after an action, independent of the model's own `screenshot` tool
   * (which it is told to use sparingly). The glm-loop calls it after every
   * executed action and emits the frame as a `live: true` browser-observation.
   * Best-effort: resolves null (never throws) when the driver has nothing to
   * show — no page yet, an unchanged page (cloud dedupes per URL), a capture
   * failure. Drivers that cannot render pixels simply omit it.
   */
  liveView?(): Promise<LiveViewFrame | null>;
}

/** One live-view capture for the browser panel. */
export interface LiveViewFrame {
  screenshotBase64: string;
  /** 'image/png' | 'image/jpeg' */
  mime: string;
  url?: string;
}

export interface BrowserAgentInput {
  userId: string;
  chatId: string | null;
  message: string;
  attachment?: unknown;
  sessionId?: string | null;
  /** ea3ad8a8 — the hosted hardened browser's per-session context key.
   *  `chat:<chatId>` for plain chats, `session:<sessionId>` for coding runs.
   *  Set by the callers; when absent the router never offers the hosted
   *  destination (legacy behavior unchanged). */
  sessionKey?: string | null;
  /** SSE emitter from the controller — (type, data) => void. */
  sendEvent: (type: string, data: any) => void;
  /** Cap loop steps below the default (tool-delegated sub-sessions run bounded). */
  maxSteps?: number;
  /** Wall-clock budget in ms — past it, tools are dropped so the model must answer. */
  deadlineMs?: number;
  /** false = skip the per-action live-view captures (default on). */
  liveView?: boolean;
  /** Per-task CDP-attach opt-in (ticket 4258335e): run the local session in a
   *  dedicated new tab of the user's EVERYDAY Chrome on their Mac. Requires a
   *  ≥0.5.0 agent AND the owner-side master switch on the Mac; falls back to
   *  Digby's own profile otherwise (the result reports the ACTUAL mode). */
  attach?: boolean;
  /** Multi-Mac (2026-09-24): target a specific paired Mac by label/name/id.
   *  Omit to use the default Mac (single-Mac users see zero change). */
  device?: string;
  /** Ticket 8fe9429c (2026-09-25): the DEVICE-INPUT mode the COMPUTER
   *  destination runs in when the router hands the task to the computer
   *  agent. 'observe' = camera-only (screenshots/uia_tree reads; every input
   *  action refused at the computer-loop dispatch gate) — the mode a delegated
   *  read-only worker's session runs in, so an observation sub-task can never
   *  click/type/quit apps on the user's desktop. Absent = 'full' (the
   *  historical behavior). Applies ONLY to the computer handoff — the cloud /
   *  local Digby-profile browser drivers are unaffected. */
  computerInputMode?: 'full' | 'observe';
  /** cu-diag 2026-09-25 fix #6 — passed through to the COMPUTER handoff only:
   *  a machine-triggered run becomes camera-only when the owner appears
   *  active on the device (OWNER_PRESENCE_GATE_DISABLED=1 kills it). */
  machineTriggered?: boolean;
  /** cu-diag fix #6 — who is driving (recorded next to the device use-lock so
   *  a contending session's refusal can name the holder). Computer handoff only. */
  holder?: { chatId?: string | null; lane?: string | null };
}

export interface BrowserAgentResult {
  finalResponse: string;
  elapsed: number;
  title?: string | null;
  /** 'computer' = the router handed the task to the computer agent (the user's
   *  real desktop) instead of a browser driver (2026-09-09). */
  driverUsed: 'cloud' | 'local' | 'computer' | 'hosted';
  /** Why this driver was chosen (the router's reason — surfaced for transparency,
   *  feedback 2027d98d). */
  driverReason?: string;
  /** Local (paired-Mac) browser availability at selection time — lets the caller
   *  answer "why didn't my Mac's browser engage?" (feedback 2027d98d). */
  localBrowserStatus?: string;
  /** Hard, cause-naming notice present when the session's final driver could not
   *  interact (click/type/scroll/screenshot) and no fallback driver engaged;
   *  absent on fully-interactive sessions (feedback c3c06260). */
  capabilityNotice?: string;
  /** Ticket ccd634fb: the session ran on a read-only cloud driver but the limit never bit —
   *  no interactive action was refused, the model finished with a `done` answer and did not flag
   *  that the task needed interaction. A one-line fact for the result HEADER instead of the hard
   *  capabilityNotice banner (which read as a FAILED tool on a successful page read). */
  readOnlyNote?: string;
  /** True when the caller requested CDP-attach mode for this task (4258335e). */
  attachRequested?: boolean;
  /** Which local browser ACTUALLY drove (from the agent's observations):
   *  'attached' = the user's everyday Chrome; 'digby-profile' = Digby's own
   *  profile. Undefined when no local observation reported a mode (cloud run,
   *  computer handoff, or a pre-0.5.0 agent). */
  localBrowserMode?: 'digby-profile' | 'attached';
  /** Ticket 8fe9429c — true when the COMPUTER destination ran in OBSERVE-ONLY
   *  mode (computerInputMode 'observe': camera on the user's desktop, every
   *  input action refused). Undefined for browser-driver runs. */
  computerObserveOnly?: boolean;
  steps: number;
}
