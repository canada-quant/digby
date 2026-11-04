/**
 * Computer-use vision loop.
 *
 * A vision model (gpt-5.6-luna via the self-contained Responses client) sees the
 * user's Mac screen and drives it step by step: screenshot → action → fresh
 * screenshot → … → done. The action vocabulary rides as Responses-API function
 * tools; every dispatched observation carries a fresh screenshot (the driver
 * auto-screenshots after input actions), so the model always sees the effect of
 * its last step. Mirrors the browser-agent's glm-loop structure (step cap,
 * wall-clock deadline, degeneration nudge, forced wrap-up), with one deliberate
 * difference per the owner's autonomy directive: NO confirm gates on
 * state-changing actions — the user asked for autonomy; the audit trail is the
 * SSE observation stream.
 *
 * SSE surfaced to the UI (all additive):
 *   progress             — driver selection + wrap-up notes
 *   computer-observation — {action, ok, preview, reasoning, driver:'computer'}
 *                          after each action, plus a screenshot passthrough
 *                          {action:'screenshot', screenshotBase64, mime:'image/jpeg',
 *                          app, live:true} when one is present. The tool path
 *                          (tool-executor) forwards these into the calling run's
 *                          stream as `browser_observation` frames, so the chat /
 *                          session Browser panel shows the user's Mac screen live
 *                          exactly like a browser browse (2026-09-09).
 *   chunk                — the final answer (single emission)
 */

import logger from "../../../utils/logger";
import { selectComputerDriver } from "./driver";
import { UIA_DISPATCH_MIN_AGENT_VERSION } from "./availability";
import {
  acquireComputerUseLock,
  releaseComputerUseLock,
  recordComputerUseHolder,
  describeComputerUseHolder,
  LOCK_TTL_MARGIN_MS,
} from "./use-lock";
import {
  visionChat,
  visionConfigured,
  VisionInputItem,
  VisionToolDef,
} from "./vision-client";
import {
  ComputerAction,
  ComputerAgentInput,
  ComputerAgentResult,
  ComputerHarnessCounters,
  ComputerObservation,
} from "./types";
import {
  analyzeFrame,
  describeFrameMetrics,
  frameDiffPercent,
  FrameMetrics,
} from "./frame-readability";
import { looksLikeLeakedChatToolCall } from "../chat-agent/tool-call-leak";
import { preloginRefusalNotice } from "./prelogin-refusal";

const MAX_STEPS = 12;
const DEADLINE_MS = 300_000;
/** Ticket ac9022a0 — write-path watchdog: this many CONSECUTIVE input actions
 *  whose post-action frame is byte-identical to the pre-action one ends the
 *  task with a loud blocked report (see the loop body). Since cu-diag fix #2
 *  (2026-09-25) this is the FALLBACK limit — the harness positive-control
 *  probe at PROBE_AT_STRIKES decides first wherever it can run. */
const NO_CHANGE_LIMIT = 3;
/** cu-diag fix #2: at this many consecutive strikes the HARNESS ITSELF
 *  dispatches a known-visible positive control (Cmd+Space, then Escape) and
 *  aborts only if that probe ALSO yields an identical frame with an unchanged
 *  frontmost app. macOS only (the probe is a Spotlight keystroke);
 *  never in observe-only sessions (it IS input). */
const PROBE_AT_STRIKES = 2;
/** Review fix (2026-09-25, cu-diag fix #2 follow-up): the probe runs ONLY on
 *  the action that just SCORED a strike, and at most this many times per
 *  session. An INCONCLUSIVE probe (the agent refused the Cmd+Space dispatch,
 *  the follow-up screenshot failed, or the driver threw) leaves the streak
 *  where it was, and the old `streak >= 2` gate then re-fired the probe on
 *  EVERY later action of any kind — screenshots, waits, bare Escape presses —
 *  until the step cap (4 Cmd+Space/Escape pairs in a 7-action replay). Now an
 *  inconclusive probe is retried at most ONCE, on the next genuine strike
 *  (strike 3 — right before the legacy NO_CHANGE_LIMIT abort), never on
 *  reads / no-op keys / the same streak level. */
const MAX_PROBE_ATTEMPTS = 2;
/** cu-diag fix #3: the repeated-action nudge no longer consumes a step. This
 *  bounds how many free nudges a session gets before they cost a step again
 *  (termination guarantee — the wall-clock deadline is the other bound). */
const MAX_FREE_NUDGES = 4;
/** cu-diag fix #3: the `wait` tool — bounded pause + fresh screenshot that
 *  does not consume a step (up to MAX_FREE_WAITS free waits per session). */
export const WAIT_MAX_SECONDS = 10;
const MAX_FREE_WAITS = 6;

const envOn = (name: string): boolean => String(process.env[name] ?? "").trim() === "1";
/** cu-diag fix #2 kill switch (default OFF = new behaviour ON). */
const clickStrikesLegacy = () => envOn("COMPUTER_CLICK_STRIKES_LEGACY");
/** cu-diag fix #3 kill switch. */
const degenerationGuardLegacy = () => envOn("COMPUTER_DEGENERATION_GUARD_LEGACY");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * cu-diag fix #3: the `wait` tool. Offered alongside the platform vocabulary
 * (never inside COMPUTER_TOOLS itself — that array is pinned as the
 * historical eight); the loop turns it into a bounded pause + a fresh
 * screenshot and does NOT charge a step for it (up to MAX_FREE_WAITS).
 */
export const WAIT_TOOL: VisionToolDef = {
  type: "function",
  name: "wait",
  description:
    `Pause up to ${WAIT_MAX_SECONDS} seconds for the screen to settle (an app launching, a page loading, an animation), then receive a fresh screenshot. Does not consume a step. Use this instead of repeating screenshot.`,
  parameters: {
    type: "object",
    properties: {
      seconds: { type: "number", description: `How long to wait, 0.5–${WAIT_MAX_SECONDS} (default 2).` },
      reasoning: { type: "string", description: "What you are waiting for." },
    },
  },
};

/** cu-diag fix #3: the wait bound — 0.5..WAIT_MAX_SECONDS, never past the
 *  session deadline (`remainingMs`), 0 when the deadline has passed. */
export function clampWaitSeconds(requested: unknown, remainingMs: number): number {
  const req = typeof requested === "number" && Number.isFinite(requested) ? requested : 2;
  const bounded = Math.min(WAIT_MAX_SECONDS, Math.max(0.5, req));
  if (remainingMs <= 0) return 0;
  return Math.min(bounded, remainingMs / 1000);
}

/** The tool list actually OFFERED to the model: the platform vocabulary plus
 *  `wait`. */
export function withWaitTool(tools: VisionToolDef[]): VisionToolDef[] {
  if (tools.some((t) => t.name === "wait")) return tools;
  return [...tools, WAIT_TOOL];
}

/** Instruction addendum that rides with the wait tool + the harness facts
 *  (cu-diag fix #5: the harness states the frame diff after every action so
 *  the model never has to INFER whether the screen changed). */
const HARNESS_FACTS_SENTENCE =
  `HARNESS FACTS: after every action the harness appends a "harness:" line to the tool result stating what IT measured — "bytes identical", "N% of pixels changed" or "bytes differ, <0.1% of pixels changed" (a change too small for the harness thumbnail, e.g. a caret or cursor), whether the frontmost app changed (A→B) and which display was captured. Trust those measurements over your own impression of the two frames.`;
const WAIT_TOOL_SENTENCE =
  `A "wait" tool is available for settling delays (an app launching, a page loading) — use it instead of repeating screenshot.`;
export function harnessFactsAddendum(): string {
  return `\n\n${HARNESS_FACTS_SENTENCE} ${WAIT_TOOL_SENTENCE}`;
}

/** cu-diag fix #5: the vision seat sometimes emits tool-call markup (DSML
 *  tokens, <tool_result>…) as plain TEXT with no tool call attached. The
 *  finalize site used to accept ANY tool-less text as the final answer, so
 *  the leaked markup shipped to the caller verbatim (message 871bf82b). */
const VISION_SEAT_LEAK_RE = /[｜|]\s*DSML\s*[｜|]|<\/?\s*(?:tool_result|tool_call|tool_calls|function_call|invoke|parameter)\b|<[｜|]/i;
export function looksLikeVisionSeatLeak(text: string): boolean {
  const t = String(text || "");
  if (!t.trim()) return false;
  return VISION_SEAT_LEAK_RE.test(t) || looksLikeLeakedChatToolCall(t);
}
export const VISION_LEAK_NUDGE =
  "[HARNESS NOTICE — not typed by the user] Your previous message contained tool-call markup as PLAIN TEXT (DSML tokens / <tool_result> / a call written out), so NO tool ran and nothing was recorded. Act through the structured tool-calling API (screenshot, click, type, key, scroll, open, wait, done…). If you are finished, call done with a plain-language final answer for the user — no markup.";

const INSTRUCTIONS = `You are operating the user's own Mac computer for them. You SEE the screen via screenshots and ACT with the provided tools — exactly ONE action per turn; after each action you receive a fresh screenshot showing the result.

Coordinate contract: screenshots are downscaled for you. ALWAYS click in the pixel coordinate space of the MOST RECENT screenshot (the image you just saw) — the agent converts to native screen coordinates. Never estimate scaling yourself.

You are an extension of the user: use THEIR existing setup. The first screenshot names the frontmost app — if the task fits what is already open (their browser with their logins, their mail client, the document they are in), continue there instead of opening something new. Use the browser and apps they already use (the default browser via open with a URL; never install or switch to a different browser). Only ask which app to use when the choice is genuinely ambiguous AND matters.

Operating guidance:
- To open an app, prefer the open tool with the app's name (or use Spotlight: key "space" with modifiers ["cmd"], type the name, key "return"). To open a website, use open with the URL (opens in their default browser, already signed in to their accounts).
- Prefer keyboard shortcuts over clicking when reliable (cmd+tab switch apps, cmd+space Spotlight, tab/return in dialogs and forms).
- After clicking into a text field, type with the type tool. To submit a form, prefer key "return" over hunting for a button.
- Verify each action's effect in the fresh screenshot before the next one. If nothing changed, reconsider (wrong coordinates, a dialog stole focus, the app is slow) rather than repeating the identical action.
- A "NO VISIBLE CHANGE" notice means the screen was pixel-identical after your action, on a verified readable screenshot: either the input did not land, or the action simply had no visible effect. Never repeat the identical action: re-ground with ONE screenshot, then try a DIFFERENT action that should visibly change the screen (open a menu, type into a field); if that also changes nothing, call done and report the task BLOCKED by input delivery (Accessibility permission / synthetic-input drop), including the setup fix for the user.
- macOS permission errors (Screen Recording / Accessibility) arrive in the tool result — relay the setup instructions to the user verbatim in your done message; do NOT retry in a loop.
- The user values autonomy: act decisively, don't ask for confirmation. Use ask_user ONLY when truly stuck (e.g. a password only the user knows). The user cannot answer mid-run, so prefer finishing with clear instructions over blocking.
- When the task is complete — or genuinely cannot proceed — call done with a full, concrete answer for the user (what you did, what you saw, anything they must finish themselves).`;

/**
 * Per-platform instructions (Windows client W0, 2026-09-25). macOS keeps the
 * exact historical text (pinned by transcript fixtures and the shipped
 * product); a Windows target splices Windows-appropriate guidance into the
 * same skeleton — the core contracts (coordinate space, verify-or-refuse, NO
 * VISIBLE CHANGE discipline, ask_user/done policy) stay byte-identical.
 */
export function instructionsForPlatform(
  platform: 'macos' | 'windows' | null | undefined,
  agentVersion?: string | null,
): string {
  if (platform !== 'windows') return INSTRUCTIONS;
  const base = INSTRUCTIONS
    .replace(
      `You are operating the user's own Mac computer for them.`,
      `You are operating the user's own Windows computer for them.`,
    )
    .replace(
      `- To open an app, prefer the open tool with the app's name (or use Spotlight: key "space" with modifiers ["cmd"], type the name, key "return"). To open a website, use open with the URL (opens in their default browser, already signed in to their accounts).`,
      `- To open an app, press the Win key (key "win"), type the app's name, press return — or use open with the app's name. To open a website, use open with the URL (opens in their default browser, already signed in to their accounts).`,
    )
    .replace(
      `- Prefer keyboard shortcuts over clicking when reliable (cmd+tab switch apps, cmd+space Spotlight, tab/return in dialogs and forms).`,
      `- Prefer keyboard shortcuts over clicking when reliable (alt+tab switch apps, Win-key search, ctrl shortcuts, tab/return in dialogs and forms). Modifier names: ctrl, alt, shift, win.`,
    )
    .replace(
      `- macOS permission errors (Screen Recording / Accessibility) arrive in the tool result — relay the setup instructions to the user verbatim in your done message; do NOT retry in a loop.`,
      `- Windows blocks some actions by design instead of showing permission prompts: an elevated (administrator) window ignores synthetic clicks/keys from a normal app (UIPI), a locked screen or secure desktop cannot be captured, and anti-cheat/DRM windows refuse capture or input. Those errors arrive in the tool result — report plainly what blocks and what the user must do (unlock the PC, click the elevated window themselves, or run the task in a non-admin window); do NOT retry in a loop.`,
    )
    .replace(
      `(Accessibility permission / synthetic-input drop), including the setup fix for the user.`,
      `(an elevated/UIPI-protected window, or synthetic input being dropped), including the fix for the user.`,
    );
  // B1 (review, PR #1064): the uia_* sentence is spliced ONLY when the agent
  // can claim the commands — a 0.8.x Windows agent must not be told about
  // tools whose dispatch would burn the broker timeout.
  return uiaToolsAvailable(platform, agentVersion)
    ? base.replace(
        `- Windows blocks some actions by design instead of showing permission prompts: an elevated (administrator) window ignores synthetic clicks/keys from a normal app (UIPI), a locked screen or secure desktop cannot be captured, and anti-cheat/DRM windows refuse capture or input. Those errors arrive in the tool result — report plainly what blocks and what the user must do (unlock the PC, click the elevated window themselves, or run the task in a non-admin window); do NOT retry in a loop.`,
        `- Windows blocks some actions by design instead of showing permission prompts: an elevated (administrator) window ignores synthetic clicks/keys from a normal app (UIPI), a locked screen or secure desktop cannot be captured, and anti-cheat/DRM windows refuse capture or input. Those errors arrive in the tool result — report plainly what blocks and what the user must do (unlock the PC, click the elevated window themselves, or run the task in a non-admin window); do NOT retry in a loop. You can ALSO call uia_tree to read the accessibility tree of the frontmost window when a screenshot is ambiguous (text fields, dense lists), and uia_invoke to activate an element by its runtime_id instead of clicking its coordinates (more reliable in elevated-sibling apps where clicks land wrong).`,
      )
    : base;
}

export const COMPUTER_TOOLS: VisionToolDef[] = [
  {
    type: "function",
    name: "screenshot",
    description:
      "Take a fresh screenshot of the Mac screen. You rarely need this — every action already returns a fresh screenshot — but use it after a wait, or when you suspect the screen changed externally.",
    parameters: {
      type: "object",
      properties: {
        reasoning: {
          type: "string",
          description: "One short sentence on why.",
        },
      },
    },
  },
  {
    type: "function",
    name: "click",
    description:
      'Click at image-pixel coordinates of the MOST RECENT screenshot. button "right" for context menus, clicks 2 for double-click (open files/apps, select words).',
    parameters: {
      type: "object",
      properties: {
        x: {
          type: "number",
          description: "Horizontal pixel coordinate in the last screenshot.",
        },
        y: {
          type: "number",
          description: "Vertical pixel coordinate in the last screenshot.",
        },
        button: { type: "string", enum: ["left", "right"] },
        clicks: { type: "number", enum: [1, 2] },
        reasoning: {
          type: "string",
          description: "What you are clicking and why.",
        },
      },
      required: ["x", "y"],
    },
  },
  {
    type: "function",
    name: "type",
    description:
      "Type text at the current keyboard focus (click the target field first).",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        reasoning: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "key",
    description:
      'Press a named key, optionally with modifiers. Keys: return, tab, space, delete, escape, left, right, up, down, home, end, pageup, pagedown, f1-f12. Modifiers: cmd, shift, ctrl, option. Examples: Spotlight = key "space" + modifiers ["cmd"]; copy = key "c" + ["cmd"].',
    parameters: {
      type: "object",
      properties: {
        key: { type: "string" },
        modifiers: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" },
      },
      required: ["key"],
    },
  },
  {
    type: "function",
    name: "scroll",
    description:
      "Scroll content. Pass x,y (image-pixel coordinates of the MOST RECENT screenshot) to scroll the content AT that point — the pointer is moved there first; without x/y it scrolls whatever is under the current pointer. Prefer passing x,y aimed at the content you want to move.",
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        amount: { type: "number", description: "Scroll lines (default 10)." },
        x: {
          type: "number",
          description:
            "Optional: horizontal pixel coordinate of the content to scroll.",
        },
        y: {
          type: "number",
          description:
            "Optional: vertical pixel coordinate of the content to scroll.",
        },
        reasoning: { type: "string" },
      },
      required: ["direction"],
    },
  },
  {
    type: "function",
    name: "open",
    description:
      'Open an application by name (e.g. "Safari", "Notes", "System Settings") or a URL in the default browser.',
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "App name or absolute URL." },
        reasoning: { type: "string" },
      },
      required: ["target"],
    },
  },
  {
    type: "function",
    name: "ask_user",
    description:
      "Surface something you cannot resolve yourself (a password, an account choice). The user cannot answer mid-run — the run wraps up with your question included. Use sparingly; prefer finishing autonomously.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "What you need from the user and why.",
        },
      },
      required: ["message"],
    },
  },
  {
    type: "function",
    name: "done",
    description:
      "The task is complete (or cannot proceed). Provide the final answer for the user.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description:
            "Full final answer: what you did, what you saw, anything left for the user.",
        },
      },
      required: ["message"],
    },
  },
];

/** W3 (Windows agent 0.9.0, 2026-09-25): UI Automation tools — Windows-ONLY
 *  additions (never appended to the macOS COMPUTER_TOOLS array, which stays
 *  byte-identical: pinned by product copy + the platform test suite). The
 *  wire methods ride the stricter 0.9.0 dispatch gate in driver.ts
 *  (UIA_DISPATCH_MIN_AGENT_VERSION) — the macOS agent (0.5.x) never sees
 *  them. Descriptions name the refusal codes verbatim: the agent returns
 *  '<CODE>: <human guidance>' and the loop forwards the string as-is. */
const UIA_TOOLS: VisionToolDef[] = [
  {
    type: "function",
    name: "uia_tree",
    description:
      'Read the UI Automation (accessibility) tree of the frontmost window (or the whole desktop with root "desktop") as compact indented text — far more reliable than a screenshot for reading text fields, dense lists, and controls whose pixels are ambiguous. Each element carries its name, role, rect, and runtime_id. Errors arrive as "<CODE>: guidance" (UIA_E_ELEVATED, UIA_E_SECURE_DESKTOP, UIA_E_DRM, UIA_E_ANTICHEAT, UIA_E_NOT_FOUND, UIA_E_UNSUPPORTED) — relay them to the user verbatim; UIA_W_DRM_SUSPECTED warnings ride the tree text itself.',
    parameters: {
      type: "object",
      properties: {
        root: { type: "string", enum: ["foreground", "desktop"], description: "Which window to walk (default foreground)." },
        max_depth: { type: "number", description: "Depth bound, 1..12 (default 6)." },
        max_nodes: { type: "number", description: "Node-count bound, 1..1000 (default 300)." },
        reasoning: { type: "string", description: "One short sentence on why." },
      },
    },
  },
  {
    type: "function",
    name: "uia_invoke",
    description:
      "Activate a UI Automation element by its runtime_id (from a uia_tree observation) — a click-free alternative that works even in elevated-sibling apps where synthetic clicks land wrong (UIPI). Patterns: invoke (buttons/links), toggle (checkboxes/switches), expand (trees/combo boxes), select (list items/tabs), focus (move keyboard focus), set_value (set a text field's value — requires text). Errors arrive as \"<CODE>: guidance\" (UIA_E_ELEVATED, UIA_E_SECURE_DESKTOP, UIA_E_DRM, UIA_E_ANTICHEAT, UIA_E_NOT_FOUND, UIA_E_UNSUPPORTED) — relay them to the user verbatim.",
    parameters: {
      type: "object",
      properties: {
        runtime_id: {
          type: "array",
          items: { type: "number" },
          description: "The element's runtime_id array from a uia_tree observation.",
        },
        pattern: {
          type: "string",
          enum: ["invoke", "toggle", "expand", "select", "focus", "set_value"],
        },
        text: {
          type: "string",
          description: 'The value to set (required when pattern is "set_value").',
        },
        reasoning: { type: "string", description: "What you are activating and why." },
      },
      required: ["runtime_id", "pattern"],
    },
  },
];

/**
 * Per-platform tool doctrine (W1 multi-device, 2026-09-25): the ACTION
 * vocabulary is identical on every platform — only the DESCRIPTIONS name
 * platform specifics. macOS (and null/undefined — no platform resolved) keeps
 * the exact historical text (pinned by the shipped product); a Windows target
 * rewrites ONLY doctrinal text: the screen noun, the modifier vocabulary +
 * examples (no cmd/Spotlight — ctrl/alt/win and the Start menu), and the open
 * examples (Chrome/Notepad/Settings, not Safari/Notes/System Settings). Param
 * SCHEMAS are byte-identical — same tool names, same types, same required
 * fields — so the model's calling shape never changes with the platform.
 *
 * W3 (2026-09-25): a Windows target ADDITIONALLY receives the two UIA tools
 * (uia_tree / uia_invoke) — appended after the core set, offered to the model
 * on the windows branch only. macOS (and null/undefined) keeps exactly the
 * historical eight-tool array.
 */
/** W3 (Windows 0.9.0): true when the UIA tools may be OFFERED — windows
 *  platform AND an agent new enough to claim computer_uia_* (the dispatch
 *  gate would requeue against anything older, burning the 45s broker timeout
 *  with a misleading "did not respond" error — review B1, PR #1064). */
export function uiaToolsAvailable(
  platform: 'macos' | 'windows' | null | undefined,
  agentVersion: string | null | undefined,
): boolean {
  if (platform !== 'windows') return false;
  const min = UIA_DISPATCH_MIN_AGENT_VERSION.split('.').map(Number);
  const parts = String(agentVersion || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    if (a > min[i]) return true;
    if (a < min[i]) return false;
  }
  return true; // equal
}

/**
 * Ticket 8fe9429c (2026-09-25) — the OBSERVE-ONLY tool vocabulary. A delegated
 * read-only worker's computer-use session gets ONLY the camera: screenshot (and
 * the Windows uia_tree read when the agent can claim it) plus done. The input
 * tools (click / type / key — the vocabulary that pressed ⌘Q on Terminal and
 * killed a nohup'd tar+scp transfer — / scroll / open / uia_invoke / ask_user)
 * are not even OFFERED to the vision model, so it cannot select them.
 *
 * The dispatch gate in runComputerAgentSession is the enforcement point (the
 * tool list alone is a hint, not a boundary — the model could still emit an
 * off-list tool call); this function only keeps the OFFERED surface honest.
 */
export function observeOnlyTools(
  platform: 'macos' | 'windows' | null | undefined,
  agentVersion: string | null | undefined,
): VisionToolDef[] {
  const observe: VisionToolDef[] = [
    COMPUTER_TOOLS.find((t) => t.name === "screenshot")!,
    ...(uiaToolsAvailable(platform, agentVersion)
      ? [UIA_TOOLS.find((t) => t.name === "uia_tree")!]
      : []),
    COMPUTER_TOOLS.find((t) => t.name === "done")!,
  ];
  return observe;
}

/** Ticket 8fe9429c — the observe-only instruction addendum: the vision model
 *  is TOLD it is camera-only (screenshots + reads) so it plans an observation
 *  task instead of an interaction one, and is told what to do when its task
 *  actually needs input: report back that the orchestrator must act. */
const OBSERVE_ONLY_ADDENDUM = `

OBSERVE-ONLY SESSION: you are a camera on this screen, NOT a pair of hands. You may look (screenshot, and uia_tree where offered) but you CANNOT click, type, press keys, scroll, open apps, or activate UI elements — any such action is refused by the harness before it reaches the device. Do not attempt input actions, and do not ask the user to grant more access: your caller (a read-only observation worker) was granted camera-only access deliberately. If the task genuinely requires acting on the screen (clicking, typing, quitting an app), call done and report exactly what action is needed so the orchestrator can perform it with full computer use.`;

/** Ticket 8fe9429c — the input-action vocabulary refused in observe-only mode.
 *  screenshot and uia_tree are READS (camera + accessibility-tree read); done
 *  and ask_user are session control. Everything else dispatches synthetic
 *  input or launches apps — refused. */
const OBSERVE_REFUSED_ACTIONS: ReadonlySet<string> = new Set([
  "click",
  "type",
  "key",
  "scroll",
  "open",
  "uia_invoke",
]);

/** Ticket 8fe9429c — the refusal the vision model receives when it attempts an
 *  input action in observe-only mode. Named like the driver's own refusals so
 *  the model treats it as a hard capability limit, not a transient error. */
export const OBSERVE_ONLY_REFUSAL =
  "OBSERVE-ONLY SESSION — input refused: this computer-use session is camera-only (it was spawned by a read-only observation worker), so the action was NOT dispatched to the device. You may screenshot (and uia_tree where offered) and then call done. If the task requires acting on the screen, call done and report what action is needed.";

export function computerToolsForPlatform(
  platform: 'macos' | 'windows' | null | undefined,
  agentVersion?: string | null,
): VisionToolDef[] {
  if (platform !== 'windows') return COMPUTER_TOOLS;
  const core = COMPUTER_TOOLS.map((t) => {
    switch (t.name) {
      case 'screenshot':
        return { ...t, description: t.description.replace('the Mac screen', 'the Windows screen') };
      case 'key':
        return {
          ...t,
          description: t.description.replace(
            'Modifiers: cmd, shift, ctrl, option. Examples: Spotlight = key "space" + modifiers ["cmd"]; copy = key "c" + ["cmd"].',
            'Modifiers: ctrl, alt, shift, win. Examples: Start menu = key "win"; copy = key "c" + ["ctrl"].',
          ),
        };
      case 'open':
        return { ...t, description: t.description.replace('"Safari", "Notes", "System Settings"', '"Chrome", "Notepad", "Settings"') };
      default:
        return t;
    }
  });
  // B1 (review, PR #1064): offer the UIA tools ONLY when the selected agent
  // can actually claim them (windows + ≥0.9.0). A 0.8.x Windows agent gets
  // the plain core set — the model is never steered into a 45s timeout.
  if (!uiaToolsAvailable(platform, agentVersion)) return core;
  return [...core, ...UIA_TOOLS.map((t) => ({ ...t }))];
}

/** Drop every screenshot currently in the input — call right BEFORE pushing a
 *  fresh one. Image payloads dominate the request size; the model grounds on
 *  the CURRENT screen, not history. */
/** cu-diag fix #5: the placeholder says WHY the frame is gone and WHERE the
 *  live one is — the old "[earlier screenshot omitted]" was narrated by the
 *  vision seat as "every screenshot was returned as omitted/unavailable"
 *  (message 06321527) while a healthy 275 KB frame sat right below it. */
export const EARLIER_FRAME_PLACEHOLDER =
  "[earlier frame dropped to save context — the CURRENT frame is attached below]";
function stripOlderImages(input: VisionInputItem[]): void {
  input.forEach((item) => {
    if (!("role" in item) || item.role !== "user") return;
    item.content = item.content.map((c) =>
      c.type === "input_image"
        ? { type: "input_text", text: EARLIER_FRAME_PLACEHOLDER }
        : c,
    );
  });
}

/** W3 (Windows 0.9.0): same context discipline for uia_tree payloads — keep
 *  only the LATEST accessibility tree in the input. A tree walks up to 1000
 *  nodes of text; letting several accumulate would bloat the request exactly
 *  like stacked screenshots. The tree text is tagged with a stable prefix so
 *  the strip can find it (the function_call_output receipt stays — it's tiny). */
const TREE_MARKER = "Accessibility tree of the";
function stripOlderTrees(input: VisionInputItem[]): void {
  input.forEach((item) => {
    if (!("role" in item) || item.role !== "user") return;
    item.content = item.content.map((c) =>
      c.type === "input_text" && c.text.startsWith(TREE_MARKER)
        ? { type: "input_text", text: "[earlier accessibility tree omitted]" }
        : c,
    );
  });
}

function userImageMessage(text: string, base64: string): VisionInputItem {
  return {
    role: "user",
    content: [
      { type: "input_text", text },
      { type: "input_image", image_url: `data:image/jpeg;base64,${base64}` },
    ],
  };
}

/** cu-diag 2026-09-25 fix #1: the display/geometry facts an observation
 *  carries (agent ≥ 0.6.1; every field undefined on older agents — the panel
 *  and the event log simply omit them). Forwarded into the screenshot frame
 *  AND the per-action browser_observation event so the harness records
 *  per-frame geometry (the incident's "1568×1013 vs 1568×882" leg was
 *  narration-only because nothing recorded it). */
export function observationGeometry(obs: Pick<ComputerObservation,
  "imageWidth" | "imageHeight" | "displayId" | "displayCount" | "displayIndex" | "frontmostWindowDisplayId" | "hidIdleSeconds">) {
  return {
    ...(typeof obs.imageWidth === "number" ? { imageWidth: obs.imageWidth } : {}),
    ...(typeof obs.imageHeight === "number" ? { imageHeight: obs.imageHeight } : {}),
    ...(typeof obs.displayId === "number" ? { displayId: obs.displayId } : {}),
    ...(typeof obs.displayCount === "number" ? { displayCount: obs.displayCount } : {}),
    ...(typeof obs.displayIndex === "number" ? { displayIndex: obs.displayIndex } : {}),
    ...(obs.frontmostWindowDisplayId !== undefined ? { frontmostWindowDisplayId: obs.frontmostWindowDisplayId } : {}),
    ...(obs.hidIdleSeconds !== undefined ? { hidIdleSeconds: obs.hidIdleSeconds } : {}),
  };
}

/** The panel's screen frame for an observation carrying a screenshot. */
function screenshotFrame(obs: ComputerObservation, live: boolean) {
  return {
    action: "screenshot",
    ok: true,
    driver: "computer",
    mime: "image/jpeg",
    app: obs.frontmostApp,
    screenshotBase64: obs.screenshotBase64,
    ...observationGeometry(obs),
    ...(live ? { live: true } : {}),
  };
}

// ── Focus split (cu-diag 2026-09-25 fix #1) ──────────────────────────────────
// The incident: the frontmost window lived on a display the agent was not
// capturing, so every frame was byte-identical while every keystroke landed.
// An agent ≥ 0.6.1 reports BOTH the captured display and the display owning
// the frontmost window; when they differ the model is told LOUDLY that its
// focus is off-camera, and the byte-identity watchdog does NOT score a
// strike (an unchanged frame of the wrong display proves nothing about input).

/** true when the observation proves the frontmost window is on a display
 *  other than the captured one (both ids known and different). Undefined
 *  fields (older agents) never count as a split. */
export function focusSplit(obs: Pick<ComputerObservation, "displayId" | "frontmostWindowDisplayId">): boolean {
  return (
    typeof obs.displayId === "number" &&
    typeof obs.frontmostWindowDisplayId === "number" &&
    obs.displayId !== obs.frontmostWindowDisplayId
  );
}

export const FOCUS_SPLIT_TAG = "[FOCUS ON UNCAPTURED DISPLAY]";

export function focusSplitNotice(obs: Pick<ComputerObservation, "displayId" | "frontmostWindowDisplayId" | "displayCount" | "frontmostApp">): string {
  const app = obs.frontmostApp ? ` (${obs.frontmostApp})` : "";
  return (
    `${FOCUS_SPLIT_TAG} The frontmost window${app} is on display ${obs.frontmostWindowDisplayId}, but this screenshot shows display ${obs.displayId}` +
    (typeof obs.displayCount === "number" ? ` of ${obs.displayCount}` : "") +
    ". Your keyboard/mouse input is landing on a screen you are NOT seeing — an unchanged frame here is NOT evidence that input failed. " +
    "Take ONE screenshot (the agent re-targets the frontmost window's display), or move the window onto the captured display (e.g. with the app's Window menu) before judging the result."
  );
}

// ── Owner-presence gate (cu-diag 2026-09-25 fix #6) ──────────────────────────
// Three drivers shared one Mac that evening (two lanes, a supervisor, and the
// owner over Screen Sharing/TeamViewer) and every loop assumed it owned the
// pointer. An agent ≥ 0.6.1 reports hidIdleSeconds (excluding its own events)
// and a remote-session hint; when the owner appears ACTIVE, a MACHINE-
// triggered session (supervisor wake, schedule, lane) becomes camera-only for
// the rest of its run and an interactive session gets a one-line note.
// OWNER_PRESENCE_IDLE_SEC tunes the "recent input" window (default 120 s).

export const OWNER_PRESENCE_IDLE_SEC_DEFAULT = 120;

export function ownerPresenceIdleSec(): number {
  const s = String(process.env.OWNER_PRESENCE_IDLE_SEC ?? "").trim();
  if (!s) return OWNER_PRESENCE_IDLE_SEC_DEFAULT; // Number("") is 0 — an empty env must mean "default"
  const raw = Number(s);
  return Number.isFinite(raw) && raw >= 0 ? raw : OWNER_PRESENCE_IDLE_SEC_DEFAULT;
}

/** Pure verdict from one observation: is a human using this device right
 *  now? Unknown idle (null/undefined — older agent, or the last HID event was
 *  ours with no human event seen yet) is NOT presence. */
export function ownerPresence(
  obs: Pick<ComputerObservation, "hidIdleSeconds" | "remoteSession">,
  idleWindowSec: number = ownerPresenceIdleSec(),
): { active: boolean; reason: string } {
  const remote = obs.remoteSession && obs.remoteSession.active
    ? `remote-control session attached (${(obs.remoteSession.kinds || []).join(", ") || "unknown kind"})`
    : "";
  const idle = typeof obs.hidIdleSeconds === "number" && Number.isFinite(obs.hidIdleSeconds) ? obs.hidIdleSeconds : null;
  const recent = idle !== null && idle < idleWindowSec ? `human input ${Math.round(idle)} s ago` : "";
  if (remote && recent) return { active: true, reason: `${recent}; ${remote}` };
  if (remote) return { active: true, reason: remote };
  if (recent) return { active: true, reason: recent };
  return { active: false, reason: idle === null ? "owner idle time unknown" : `no human input for ${Math.round(idle)} s` };
}

/** Same action+args 3 times running = the model is stuck; nudge it once. */
function repeatedSignature(sig: string[]): boolean {
  return (
    sig.length >= 3 &&
    sig[sig.length - 1] === sig[sig.length - 2] &&
    sig[sig.length - 2] === sig[sig.length - 3]
  );
}

/**
 * cu-diag fix #3 (2026-09-25): the degeneration-guard signature.
 *
 * The old signature (`name:[x,y,text,key,target,direction]`) had two live
 * failure modes: `screenshot` is CONSTANT, so an 8-screenshot camera task was
 * refused on its 3rd/6th/… frame (app_error_logs 18:12Z), and `key` omitted
 * modifiers, so cmd+space (Spotlight) after two bare spaces read as the
 * identical action. Now: reads (screenshot / uia_tree / wait) never form a
 * signature (null — they are legitimately repeated while watching a screen
 * settle); every input-shaping arg is included, so cmd+space ≠ space,
 * right-click ≠ left-click, double ≠ single, scroll 5 ≠ scroll 10.
 * COMPUTER_DEGENERATION_GUARD_LEGACY=1 restores the old shape.
 */
export function actionSignature(action: ComputerAction): string | null {
  if (degenerationGuardLegacy()) {
    return `${action.name}:${JSON.stringify([action.x, action.y, action.text, action.key, action.target, action.direction])}`;
  }
  if (action.name === "screenshot" || action.name === "uia_tree" || action.name === "wait") return null;
  // Repeating a NAVIGATION key (up/down/tab/pageup… — the noOpProneKey set) or
  // a scroll is how a list or a long page is traversed: three "up" presses
  // (app_error_logs 21:22Z) are not degeneration. The step cap bounds them.
  if (noOpProneKey(action) || action.name === "scroll") return null;
  return `${action.name}:${JSON.stringify([
    action.x,
    action.y,
    action.button,
    action.clicks,
    action.text,
    action.key,
    (action.modifiers || []).map((m) => String(m).toLowerCase()).sort(),
    action.direction,
    action.amount,
    action.target,
    action.runtime_id,
    action.pattern,
  ])}`;
}

/**
 * 6f4f8b36 (RC2) — a bare (modifier-less) key whose EXPECTED effect on a
 * perfectly healthy screen is often "nothing visibly happens": dismissals
 * (escape), focus moves (tab), and cursor/scroll navigation (arrows, home,
 * end, pageup, pagedown). The live incident: three Escape presses with no
 * menu/dropdown open left the screen pixel-identical — the CORRECT outcome —
 * and each scored a no-change strike, aborting a healthy session with
 * "input is not landing" while the owner watched the input land.
 *
 * Pixel-identity after one of these is NOT dead-input evidence, so the
 * watchdog neither strikes nor warns on it (the streak HOLDS — genuinely
 * dead clicks around them still accumulate). Modifier-bearing keys
 * (cmd+space, cmd+tab, cmd+c…) DO carry visible effects and stay
 * strike-eligible; every other action shape returns false.
 */
export function noOpProneKey(action: Pick<ComputerAction, "name" | "key" | "modifiers">): boolean {
  if (action.name !== "key") return false;
  if (action.modifiers && action.modifiers.length > 0) return false;
  // Case-insensitive: the device agents lowercase key names themselves
  // (imessage-agent computer.ts, windows-agent win-platform.ts), so the
  // model's casing ("Escape", "TAB") must not decide whether the carve-out
  // applies (adversarial review finding 1, PR review 2026-09-25).
  const key = String(action.key || "").trim().toLowerCase();
  return [
    "escape",
    "tab",
    "left",
    "right",
    "up",
    "down",
    "home",
    "end",
    "pageup",
    "pagedown",
  ].includes(key);
}

/**
 * Degenerate-frame detector (ticket 33401f39, 2026-09-24): the paired Mac
 * (Digby Mac app v0.4.2, status "connected", Screen Recording + Accessibility
 * granted per the user's System Settings screenshots) returned
 * black/unreadable frames for a whole computer-task run while every gate said
 * ok — macOS serves newly-granted capture permission only to a freshly
 * launched process, and a helper predating the grant captures solids. A solid
 * (black/white/gray) capture still encodes to a structurally-valid ~20 KB JPEG
 * that passes every presence check, so the only backend-visible signal is
 * compression density: bytes-per-pixel.
 *
 * CALIBRATION (measured — adversarial review of PR #1030, 2026-09-24, PIL q75
 * at the agent's geometry): solids land at bpp ≈ 0.0162; SPARSE-BUT-REAL
 * screens OVERLAP that band (dark desktop + menu bar ≈ 0.019, + dock ≈ 0.022,
 * mostly-blank light-mode document ≈ 0.026); content-rich screens sit at
 * ≈ 0.07+ (dark terminal with text ≈ 0.073, busy screen ≈ 0.153). Because the
 * bands overlap, density alone CANNOT prove a capture is unreadable — it is a
 * CAUTION signal for the vision model (which sees the frame and can judge
 * readability), never a hard refusal. DEGENERATE_BPP_THRESHOLD = 0.03 sits
 * ≈1.85× above the solid band. Absolute size cannot detect the class (a solid
 * JPEG is still ~20 KB of headers + DC coefficients); the ratio is the metric.
 */
export const DEGENERATE_BPP_THRESHOLD = 0.03;

/** bytes-per-pixel of a screenshot observation; 0 when the shape is unusable. */
export function screenshotBpp(obs: Pick<ComputerObservation, "screenshotBase64" | "imageWidth" | "imageHeight">): number {
  const px = Number(obs.imageWidth || 0) * Number(obs.imageHeight || 0);
  const bytes = obs.screenshotBase64 ? (obs.screenshotBase64.length * 3) / 4 : 0; // base64 → raw bytes
  if (!px || !bytes) return 0;
  return bytes / px;
}

/**
 * The caution that rides a low-density frame: names BOTH plausible causes (a
 * stale-helper solid capture — the v0.4.2 incident class, fixed by quitting
 * and relaunching the Mac app — and a dark/quiet REAL screen) and defers the
 * readability judgment to the vision model, which actually sees the frame.
 * Density cannot prove unreadability (sparse real screens overlap the solid
 * band — see the calibration above), so this is a caution, never a refusal.
 */
export function degenerateFrameNotice(bpp: number, detail?: string): string {
  // cu-diag fix #4 (2026-09-25): the caution is ADVISORY — no "call done NOW"
  // escalation (the incident run received 44 of them on readable dark
  // Terminal frames). The model, which sees the frame, decides.
  return (
    `CAUTION: this frame scored LOW on readability (${detail || `${bpp.toFixed(4)} bytes/pixel vs ≈0.07+ for a typical content-rich screen`}). ` +
    "It is either a solid/unreadable capture (the Mac app's helper predating a Screen Recording grant captures solids while still reporting 'connected' — a QUIT + RELAUNCH of the Digby Mac app fixes that) " +
    "or simply a dark/quiet real screen. LOOK at the frame: if it is a flat solid with no UI at all, say so in your done message and include the quit-and-relaunch fix (⌘Q the Digby Mac app, reopen it, then retry); if it is a readable dark screen, continue normally — this caution is advisory and will not repeat while the frames stay low."
  );
}

/**
 * Pure (exported for the tests): the wall-clock deadline once the use-lock is
 * held. Default: `lockAcquiredAt + deadlineMs` — the lock wait is not the
 * session's budget. COMPUTER_DEADLINE_INCLUDES_LOCK_WAIT=1 (kill switch)
 * keeps the pre-lock deadline. The lock's TTL is unaffected (it is
 * deadlineMs + margin from acquisition already).
 */
export function sessionDeadline(
  preLockDeadline: number,
  lockAcquiredAt: number,
  deadlineMs: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (String(env.COMPUTER_DEADLINE_INCLUDES_LOCK_WAIT ?? "").trim() === "1") return preLockDeadline;
  return Math.max(preLockDeadline, lockAcquiredAt + deadlineMs);
}

/**
 * cu-diag fix #4 (2026-09-25): ONE readability verdict per frame. Primary =
 * the decoded metric (frame-readability.ts: luma σ + distinct colours + edge
 * density on a 256-px thumbnail — a dark Terminal scores 0.84, a solid 0).
 * Fallback = the legacy bytes-per-pixel proxy, used ONLY when the payload
 * cannot be decoded (not a JPEG / corrupt / decoder missing). The verdict gates the write-path
 * watchdog's verifiability (a byte-identity comparison is dead-input evidence
 * only between two READABLE frames) and the LOW-READABILITY caution.
 */
export interface FrameGrade {
  readable: boolean;
  /** 'metric' (decoded) or 'bpp' (fallback). */
  basis: "metric" | "bpp";
  bpp: number;
  metrics: FrameMetrics | null;
  /** Human-readable one-liner for notices. */
  detail: string;
}
export function gradeFrame(obs: Pick<ComputerObservation, "screenshotBase64" | "imageWidth" | "imageHeight">): FrameGrade {
  const bpp = screenshotBpp(obs);
  const metrics = analyzeFrame(obs.screenshotBase64);
  if (metrics && metrics.decoded) {
    return { readable: metrics.readable, basis: "metric", bpp, metrics, detail: describeFrameMetrics(metrics) };
  }
  return {
    readable: bpp > 0 && bpp >= DEGENERATE_BPP_THRESHOLD,
    basis: "bpp",
    bpp,
    metrics,
    detail: `${bpp.toFixed(4)} bytes/pixel vs ≈0.07+ for a typical content-rich screen (payload not decodable — density proxy)`,
  };
}

/**
 * cu-diag fix #5: the harness states the frame diff itself after every
 * action so the model never infers it: "bytes identical" / "N% of pixels
 * changed" / "frontmost changed A→B" / "display M of K".
 */
export function describeFrameDiff(args: {
  prevB64: string | null;
  nextB64: string | undefined;
  prevMetrics: FrameMetrics | null;
  nextMetrics: FrameMetrics | null;
  prevApp?: string;
  nextApp?: string;
  displayIndex?: number;
  displayCount?: number;
}): string {
  const parts: string[] = [];
  if (!args.nextB64) parts.push("no frame captured");
  else if (!args.prevB64) parts.push("first frame");
  else if (args.nextB64 === args.prevB64) parts.push("bytes identical");
  else {
    const pct = frameDiffPercent(args.prevMetrics, args.nextMetrics);
    // Review follow-up (2026-09-25): a 2×14 px caret delta on a 1568×1013
    // frame rounds to 0% on the 256-px thumbnail — "0% of pixels changed"
    // read as "nothing changed" while the watchdog (byte identity) did NOT
    // strike. Say what was measured: the bytes differ, below the thumbnail.
    parts.push(
      pct === null
        ? "frame changed (bytes differ; pixel diff unavailable)"
        : pct === 0
          ? "bytes differ, <0.1% of pixels changed (below the harness thumbnail — e.g. a caret or cursor)"
          : `${pct}% of pixels changed`,
    );
  }
  if (args.nextApp && args.prevApp && args.nextApp !== args.prevApp) parts.push(`frontmost changed ${args.prevApp}→${args.nextApp}`);
  else if (args.nextApp) parts.push(`frontmost unchanged (${args.nextApp})`);
  if (typeof args.displayIndex === "number" && typeof args.displayCount === "number") {
    parts.push(`display ${args.displayIndex} of ${args.displayCount}`);
  } else if (typeof args.displayCount === "number") {
    parts.push(`${args.displayCount} display${args.displayCount === 1 ? "" : "s"}`);
  }
  return parts.join(" / ");
}

/** Display geometry fields the agent may stamp on an observation (fix #1 —
 *  a sibling change forwards them; read defensively here). */
type ObsGeometry = { displayIndex?: number; displayCount?: number; displayId?: number };
const obsGeometry = (obs: ComputerObservation): ObsGeometry => {
  const o = obs as ComputerObservation & ObsGeometry;
  return {
    displayIndex: typeof o.displayIndex === "number" ? o.displayIndex : undefined,
    displayCount: typeof o.displayCount === "number" ? o.displayCount : undefined,
    displayId: typeof o.displayId === "number" ? o.displayId : undefined,
  };
};

export async function runComputerAgentSession(
  input: ComputerAgentInput,
): Promise<ComputerAgentResult> {
  const { userId, message, sendEvent } = input;
  const maxSteps = input.maxSteps ?? MAX_STEPS;
  // Review 2026-09-25 (non-blocking #1): the deadline is RE-BASED once the
  // per-device use-lock is held (sessionDeadline below) — a contended wait
  // (up to COMPUTER_LOCK_WAIT_MS, 60 s) used to eat the session's own
  // budget, so a browser_task→computer handoff (120 s) started its loop with
  // ~60 s left and wrapped up early. COMPUTER_DEADLINE_INCLUDES_LOCK_WAIT=1
  // restores the clock starting here.
  let deadline = Date.now() + (input.deadlineMs ?? DEADLINE_MS);
  const started = Date.now();
  let steps = 0;

  // Ticket 8fe9429c (2026-09-25): a delegated read-only worker's session runs
  // CAMERA-ONLY — every synthetic-input action (click/type/key/scroll/open/
  // uia_invoke) is refused HERE, before driver.dispatch can touch the device.
  // The live incident: an observation sub-agent quit Terminal on the harvest
  // Mac (cmd+q), killing a nohup'd tar+scp transfer mid-flight. Default 'full'
  // keeps the orchestrator/lead behavior byte-identical.
  // cu-diag fix #6: `let` — the owner-presence gate can flip a MACHINE-
  // triggered session to camera-only at the first frame or mid-run.
  let observeOnly = input.inputMode === "observe";

  // ── Availability: computer use drives one of the user's paired Macs ──
  // Ticket d427c381 (2026-10-27): the task text rides selection too — when the
  // prose names a paired device and the `device` param is omitted, selection
  // auto-binds it (or refuses on an ambiguous multi-name mention) instead of
  // silently falling back to the owner's default Mac.
  const selection = await selectComputerDriver(userId, input.device, input.message);
  // d427c381: the selection's task-text facts ride EVERY result shape (success,
  // unavailable, vision-missing, busy) so the tool-result header can always
  // speak the truth about which device ran — byte-identical when absent.
  const selectionDeviceFlags = () => ({
    ...(selection.deviceAutoBound
      ? { deviceAutoBound: true, taskTextNamedDevices: selection.taskTextNamedDevices }
      : {}),
    ...(selection.taskTextNamesOtherThanParam
      ? { taskTextNamesOtherThanParam: selection.taskTextNamesOtherThanParam }
      : {}),
    // c468f922: the pre-login capability rides every result shape — a lane
    // reads a typed fact, never a guess from a loop that landed nothing.
    ...(selection.prelogin ? { prelogin: selection.prelogin } : {}),
    // c468f922 (owner ruling 2026-10-29): the BROKERED REMOTE-ACCESS verdict is
    // its OWN fact beside prelogin, never merged into it — see types.ts. A lane
    // that needs a login-window path reads this; a lane asking whether THIS
    // run's input can land reads prelogin (still 'unavailable').
    ...(selection.remoteAccess ? { remoteAccess: selection.remoteAccess } : {}),
  });
  // W0 (2026-09-25): per-platform instructions — a Windows target gets
  // Windows doctrine (Win key, alt+tab, UIPI/elevation errors) instead of the
  // macOS Spotlight/⌘ text; macOS keeps the exact historical block.
  const baseInstructions = instructionsForPlatform(selection.platform, selection.agentVersion);
  // cu-diag fix #5: the harness states every frame diff itself; fix #3: the
  // wait tool. Both addenda are switch-free text. The
  // presence gate (fix #6) re-composes the instructions when it flips a
  // machine-triggered session camera-only, so the composition is a function.
  const composeInstructions = (observe: boolean) =>
    baseInstructions + (observe ? OBSERVE_ONLY_ADDENDUM : "") + harnessFactsAddendum();
  let instructions = composeInstructions(observeOnly);
  if (!selection.driver) {
    // W1 (2026-09-25): platform-branch the retry guidance — a Windows-only
    // fleet names the Windows agent, not the Mac app. macOS/null keeps the
    // exact historical notice (pinned by the shipped product).
    const notice =
      `COMPUTER USE UNAVAILABLE — ${selection.status}. ` +
      (selection.platform === 'windows'
        ? "Nothing on the Windows PC was seen or touched. Pair/update the Digby Windows agent, then retry."
        : "Nothing on the Mac was seen or touched. Pair/update the Digby Mac app, then retry.");
    return {
      finalResponse: notice,
      elapsed: Date.now() - started,
      steps: 0,
      localStatus: selection.status,
      capabilityNotice: notice,
      ...(selection.device ? { device: selection.device } : {}),
      ...selectionDeviceFlags(),
    };
  }
  if (!(await visionConfigured())) {
    const notice =
      "COMPUTER USE UNAVAILABLE — the Computer-use vision seat is not configured on this server (assign a vision model under Account → Admin → Endpoints → Model roles, or set its provider API key).";
    return {
      finalResponse: notice,
      elapsed: Date.now() - started,
      steps: 0,
      localStatus: selection.status,
      capabilityNotice: notice,
      ...(selection.device ? { device: selection.device } : {}),
      ...selectionDeviceFlags(),
    };
  }
  // ── c468f922 (2026-10-28): FAIL FAST at a locked device ────────────────────
  // macOS puts loginwindow in its own security context (an app inside a user
  // session may not post events to it) and the Windows secure desktop is
  // likewise unreachable from a user-session process. Observed live: a
  // computer_task on a device at the login screen accepted 0 input with
  // refusedRepeats=0 / noChangeStrikes=0 — an OS-level refusal that reads
  // exactly like a stuck agent, so the lane retried and burned 4+ runs.
  // A positive lock report therefore refuses HERE, typed, before a frame is
  // captured or a lock is taken. Only a POSITIVE report refuses; a device that
  // never advertised is an honest unknown and proceeds as it always did.
  if (selection.prelogin?.blockedNow) {
    const noun = selection.platform === 'windows' ? 'Windows PC' : 'Mac';
    // c468f922 (owner ruling 2026-10-30): the refusal must name WHICH dead end
    // this is, using the typed health state. `ready` alone cannot: a locked
    // device with a working operator channel is NOT a dead end (do not send
    // anyone to physically unlock it), while a locked device whose channel is
    // off / unavailable / blocked IS one. Branching on the typed state is what
    // lets a scheduler refuse work it genuinely cannot do instead of burning
    // runs — without refusing the ordinary case, where remote access is simply
    // off because nobody opted in and computer_task never needed it.
    // The notice itself lives in ./prelogin-refusal so the three branches are
    // CALLABLE by a test (a string inlined here can only be grepped).
    const remote = selection.remoteAccess;
    const notice = preloginRefusalNotice({
      status: selection.prelogin.status,
      noun,
      preloginReason: selection.prelogin.reason,
      remoteAccess: remote,
    });
    logger.warn(
      `computer loop: user ${userId} target device ${selection.agentId} reported a lock/login screen — refusing before the loop (c468f922; remoteAccess=${remote?.state ?? 'unavailable'})`,
    );
    return {
      finalResponse: notice,
      elapsed: Date.now() - started,
      steps: 0,
      localStatus: selection.status,
      capabilityNotice: notice,
      ...(selection.device ? { device: selection.device } : {}),
      ...selectionDeviceFlags(),
    };
  }
  sendEvent("progress", { message: `Driving your ${selection.platform === 'windows' ? 'Windows PC' : 'Mac'}${selection.device && selection.device !== 'Mac' ? ` (${selection.device})` : ''} — ${selection.status}` });

  // ── Single-driver arbitration (ticket 4e4d56ff): exactly one computer-agent
  // session drives a given Mac at a time. The 2026-09-09 incident was two
  // concurrent loops (a scrape session + the cbaf3e08 hot-patch validation)
  // interleaving screenshots and input on one Mac — each loop's coordinates
  // referenced screen state the other had already changed, which presented as
  // "clicks at wrong coordinates / dead scrolls / dead arrow keys". A
  // contended lock returns a clear busy notice instead of fighting for the
  // pointer. Multi-Mac (2026-09-24): the lock is PER-DEVICE — driving the
  // MacBook Pro does not block a concurrent session on the Mac mini.
  const drivenDeviceId = selection.agentId;
  const lockTtlMs = (input.deadlineMs ?? DEADLINE_MS) + LOCK_TTL_MARGIN_MS;
  const lockWaitStarted = Date.now();
  const lockToken = await acquireComputerUseLock(
    userId,
    lockTtlMs,
    drivenDeviceId ?? undefined,
  );
  if (!lockToken) {
    // cu-diag fix #6: the refusal is STRUCTURED and names the holder (chat id
    // + lane) when the holder recorded itself — "another session" told the
    // supervisor nothing useful three times in one evening. The wait itself
    // is now 60 s (use-lock.ts lockWaitMs) before this branch is reached.
    let holder: { chatId: string | null; lane: string | null; since: string | null } | null = null;
    try {
      holder = await describeComputerUseHolder(userId, drivenDeviceId ?? undefined);
    } catch { holder = null; }
    const waitedMs = Date.now() - lockWaitStarted;
    // W1 (2026-09-25): platform-branch the busy notice; macOS/null keeps the
    // exact historical text (the holder line is appended, never rewrites it).
    const busyNoun = selection.platform === 'windows' ? 'Windows PC' : 'Mac';
    const holderLine = holder && (holder.chatId || holder.lane)
      ? ` Holder: ${holder.lane ? holder.lane : 'a session'}${holder.chatId ? ` in chat ${holder.chatId}` : ''}${holder.since ? ` since ${holder.since}` : ''}.`
      : '';
    const notice =
      `YOUR ${busyNoun.toUpperCase()} IS BUSY — another computer-use session is already driving it. ` +
      `Nothing on the ${busyNoun} was seen or touched by this run. Retry in a moment (the other session finishes within minutes).` +
      holderLine +
      ` (This run waited ${Math.round(waitedMs / 1000)} s for the device before giving up.)`;
    logger.warn(
      `computer loop: user ${userId} already has an active computer-use session on device ${drivenDeviceId} — refusing to double-drive the ${busyNoun}` +
      (holder ? ` (holder chat ${holder.chatId ?? '?'} lane ${holder.lane ?? '?'})` : ''),
    );
    return {
      finalResponse: notice,
      elapsed: Date.now() - started,
      steps: 0,
      localStatus: selection.status,
      capabilityNotice: notice,
      ...(selection.device ? { device: selection.device } : {}),
      ...selectionDeviceFlags(),
      busy: {
        holderChatId: holder?.chatId ?? null,
        holderLane: holder?.lane ?? null,
        since: holder?.since ?? null,
        waitedMs,
      },
    };
  }
  deadline = sessionDeadline(deadline, Date.now(), input.deadlineMs ?? DEADLINE_MS);
  // cu-diag fix #6: record who is driving so a contender's refusal and the
  // account overview can name us. Best-effort; older mocks/modules without
  // the export are tolerated.
  try {
    await recordComputerUseHolder(
      userId,
      drivenDeviceId ?? undefined,
      { chatId: input.holder?.chatId ?? input.chatId ?? null, lane: input.holder?.lane ?? null },
      lockTtlMs,
    );
  } catch { /* the lock itself is held — a missing holder record only degrades the refusal text */ }

  const driver = selection.driver;
  try {
    const inputItems: VisionInputItem[] = [];
    const signatures: string[] = [];
    let finalText = "";
    let askUserNote = "";
    // Write-path watchdog state (ticket ac9022a0 — see the detector block at
    // driver.execute below): the freshest frame we've seen, and the count of
    // CONSECUTIVE mutating input actions that provably changed nothing.
    let lastShotB64: string | null = null;
    // 6f4f8b36: the baseline frame's density. A byte-identity comparison is
    // only evidence of dead input when BOTH legs are content-rich — see the
    // watchdog block at driver.execute below.
    let lastShotBpp = 0;
    let noChangeStreak = 0;
    // Degenerate-frame watchdog state (ticket 33401f39): consecutive
    // post-action captures below the bpp floor (solid/unreadable frames).
    let degenerateStreak = 0;
    // cu-diag fixes #2–#5 (2026-09-25) — harness state:
    //   lastFrameGrade  — readability verdict + decoded metrics of the baseline
    //                     frame (fix #4: the verifiability gate + pixel diffs)
    //   lastFrontmost   — frontmost app on the baseline frame (fix #2: a
    //                     change is POSITIVE evidence input landed)
    //   inputProven     — a positive-control probe passed this session (fix
    //                     #2: strikes can annotate but never abort after that)
    //   counters        — what the harness measured, for the result header
    let lastFrameGrade: FrameGrade | null = null;
    let lastFrontmost: string | undefined;
    let lastGeometry: ObsGeometry = {};
    let inputProven = false;
    // Review fix (2026-09-25): the streak level at which the last probe ran
    // (0 = none yet). Together with the "this action scored a strike" gate it
    // pins that a probe never fires twice at one level and never on a read /
    // wait / no-op key after an inconclusive probe. It resets with the streak
    // (a visible change between strikes starts a fresh hypothesis).
    let probedAtStreak = 0;
    let freeNudgesLeft = MAX_FREE_NUDGES;
    let freeWaitsLeft = MAX_FREE_WAITS;
    let leakRetried = false;
    let identicalShotRun = 0;
    const counters: ComputerHarnessCounters = {
      refusedRepeats: 0,
      noChangeStrikes: 0,
      degenerateFrames: 0,
      frameGeometry: "",
      displayCount: null,
      probesRun: 0,
      probesPassed: 0,
      inputProven: false,
      frontmostChanges: 0,
    };
    const noteGeometry = (o: ComputerObservation) => {
      if (o.imageWidth && o.imageHeight) counters.frameGeometry = `${o.imageWidth}×${o.imageHeight}`;
      const g = obsGeometry(o);
      if (typeof g.displayCount === "number") counters.displayCount = g.displayCount;
      lastGeometry = g;
    };

    // ── Initial screenshot grounds the session ──
    let first: ComputerObservation;
    try {
      first = await driver.execute({ name: "screenshot" });
    } catch (e: any) {
      // W1 (2026-09-25): platform-branch the screen noun; macOS/null keeps the
      // exact historical notice.
      const noun = selection.platform === 'windows' ? "Windows PC" : "Mac";
      const notice = `Computer use could not see your ${noun}'s screen: ${e?.message || e}. ${selection.status}.`;
      return {
        finalResponse: notice,
        elapsed: Date.now() - started,
        steps: 0,
        localStatus: selection.status,
        capabilityNotice: notice,
      };
    }
    if (!first.ok || !first.screenshotBase64) {
      // W1 (2026-09-25): platform-branch the retry guidance — Windows names
      // UIPI/elevated windows instead of the macOS Screen Recording permission;
      // macOS/null keeps the exact historical notice (pinned by tests).
      const notice =
        `Computer use could not get a first screenshot from your ${selection.platform === 'windows' ? 'Windows PC' : 'Mac'}: ${first.error || "unknown error"}. ` +
        (selection.platform === 'windows'
          ? "If this mentions an elevated (administrator) window or UIPI protection, click that window yourself (or rerun the task from a non-admin window), then retry."
          : "If this mentions Screen Recording permission, follow the setup dialog that appeared on the Mac, then retry.");
      sendEvent("computer-observation", {
        action: "screenshot",
        ok: false,
        driver: "computer",
        preview: first.error || "screenshot failed",
      });
      return {
        finalResponse: notice,
        elapsed: Date.now() - started,
        steps: 0,
        localStatus: selection.status,
        capabilityNotice: notice,
      };
    }
    // Degenerate-frame caution (ticket 33401f39): a low-density FIRST frame
    // (the solid-capture class — see the calibration block) is flagged to the
    // vision MODEL, which sees the frame and judges readability. Sparse-but-
    // real dark screens overlap the solid band, so this is a caution, never a
    // hard refusal — a steps-0 refusal would block legitimate dark-desktop
    // sessions with the wrong remedy (adversarial review of PR #1030, B1).
    // cu-diag fix #4: the verdict is the DECODED readability metric (a dark
    // Terminal is readable); the bpp proxy is only the undecodable fallback.
    const firstGrade = gradeFrame(first);
    const firstBpp = firstGrade.bpp;
    let degenerateCaution = "";
    if (!firstGrade.readable && (firstGrade.basis === "metric" || firstBpp > 0)) {
      degenerateStreak = 1; // the caution fires ONCE per low-readability streak
      counters.degenerateFrames += 1;
      degenerateCaution = degenerateFrameNotice(firstBpp, firstGrade.detail);
      sendEvent("computer-observation", {
        action: "screenshot",
        ok: true,
        driver: "computer",
        preview: `low-readability first frame (${firstGrade.detail}) — caution flagged to the model`,
      });
    }
    sendEvent("computer-observation", screenshotFrame(first, true));
    lastShotB64 = first.screenshotBase64 ?? null; // watchdog baseline frame
    lastShotBpp = firstBpp; // 6f4f8b36: baseline density gate (legacy fallback)
    lastFrameGrade = firstGrade;
    lastFrontmost = first.frontmostApp;
    noteGeometry(first);

    const frontmost = first.frontmostApp
      ? ` Frontmost app: ${first.frontmostApp}${first.frontmostWindow ? ` — window "${first.frontmostWindow.slice(0, 80)}"` : ""} (the user is already using it; prefer continuing there when it fits the task).`
      : "";
    // cu-diag fix #1: name the captured display when the agent reports one,
    // and shout when the frontmost window is on a display we are not seeing.
    const displayLine = typeof first.displayId === "number"
      ? ` Captured display: ${first.displayId}${typeof first.displayCount === "number" ? ` of ${first.displayCount}` : ""}${first.displayName ? ` (${first.displayName})` : ""}.`
      : "";
    const firstSplit = focusSplit(first) ? `\n\n${focusSplitNotice(first)}` : "";
    // cu-diag fix #6: owner-presence verdict at session start. A MACHINE-
    // triggered run that finds the owner active becomes camera-only for the
    // whole run (the input tools are withdrawn AND the dispatch gate refuses);
    // an interactive run gets a one-line note so the model works around the
    // owner instead of fighting for the pointer.
    const presence0 = ownerPresence(first);
    let presenceGated = false;
    let presenceNote = "";
    if (presence0.active) {
      if (input.machineTriggered === true && !observeOnly) {
        observeOnly = true;
        presenceGated = true;
        instructions = composeInstructions(true);
        presenceNote = `\n\nOWNER ACTIVE — CAMERA-ONLY: the owner appears to be using this ${selection.platform === 'windows' ? 'PC' : 'Mac'} right now (${presence0.reason}). This machine-triggered run may only LOOK (screenshot) — every input action is refused. Report what you see; do not plan interaction.`;
        sendEvent("progress", { message: `Owner appears active (${presence0.reason}) — this machine-triggered run is camera-only.` });
        logger.info(`computer loop: owner-presence gate → observe-only for user ${userId} device ${drivenDeviceId} (${presence0.reason})`);
      } else {
        presenceNote = `\n\nNote: the owner appears active on this ${selection.platform === 'windows' ? 'PC' : 'Mac'} (${presence0.reason}) — they may move the pointer or type while you work; re-check the screen before each action and never fight them for focus.`;
      }
    }
    let ownerPresenceResult = { active: presence0.active, reason: presence0.reason, gated: presenceGated };
    // Task text must arrive INTACT. The original slice(0, 2000) silently
    // dropped chars 2000+ (ticket 24afad95): a ~4KB handoff lost its entire
    // command section and the sub-agent refused "no commands delivered"
    // while SHORT tasks in the same hour ran fine. The cap is a guard
    // against unbounded input, not a budget: 16K chars covers every real
    // handoff, and when it DOES clip it says so — never silent.
    const TASK_TEXT_CHAR_CAP = 16_000;
    const taskText = String(message || "");
    const clipped = taskText.length > TASK_TEXT_CHAR_CAP;
    const taskLine = clipped
      ? `${taskText.slice(0, TASK_TEXT_CHAR_CAP)}\n\n[TASK TRUNCATED at ${TASK_TEXT_CHAR_CAP} chars — the full task is ${taskText.length} chars; work with what is shown and report the truncation in your final answer]`
      : taskText;
    inputItems.push(
      userImageMessage(
        `Task: ${taskLine}\n\nThis is the user's ${selection.platform === 'windows' ? 'Windows PC' : 'Mac'} screen right now (screenshot ${first.imageWidth}×${first.imageHeight} px — click in THIS pixel space).${frontmost}${displayLine}${degenerateCaution ? `\n\n${degenerateCaution}` : ""}${firstSplit}${presenceNote} Begin.`,
        first.screenshotBase64,
      ),
    );

    try {
      for (steps = 0; steps < maxSteps;) {
        if (Date.now() > deadline) {
          sendEvent("progress", {
            message: "Time budget reached — wrapping up.",
          });
          break;
        }
        steps++;

        let result;
        try {
          result = await visionChat({
            instructions,
            input: inputItems,
            // W1 (2026-09-25): per-platform tool doctrine — Windows rewrites the
            // modifier/app examples in the descriptions (same schemas); macOS
            // and null keep COMPUTER_TOOLS byte-identical.
            // 8fe9429c: an observe-only session OFFERS only the camera tools
            // (screenshot / uia_tree / done) — the input vocabulary is never
            // named to the model. The dispatch gate below is the enforcement.
            // cu-diag fix #3: + the `wait` tool (camera-safe, so observe-only
            // sessions get it too).
            tools: withWaitTool(
              observeOnly
                ? observeOnlyTools(selection.platform, selection.agentVersion)
                : computerToolsForPlatform(selection.platform, selection.agentVersion),
            ),
            reasoningEffort: "low",
            maxTokens: 4096,
          });
        } catch (e: any) {
          logger.warn(
            `computer loop: vision call failed (step ${steps}): ${e?.message || e}`,
          );
          finalText = `Computer use stopped: the vision model call failed (${e?.message || e}). Anything already done on the ${selection.platform === 'windows' ? 'Windows PC' : 'Mac'} stands; retry the task.`;
          break;
        }

        // Plain text with no tool call = the model's final answer.
        if (result.functionCalls.length === 0) {
          const text = result.text.trim();
          // cu-diag fix #5: NEVER accept leaked tool markup (DSML tokens,
          // <tool_result>…, a call written out as prose) as the final answer.
          // Message 871bf82b shipped "<tool_result>screenshot called</｜｜DSML｜｜
          // parameter>" to the caller because this site finalized any
          // tool-less text. One corrective re-call (a free step); a second
          // leak ends the session with a harness message instead of the leak.
          if (looksLikeVisionSeatLeak(text)) {
            if (!leakRetried) {
              leakRetried = true;
              steps--; // the corrective round is free
              logger.warn(
                `computer loop: vision seat leaked tool markup as text at step ${steps + 1} — re-calling once with a corrective notice (cu-diag fix #5)`,
              );
              inputItems.push({ role: "user", content: [{ type: "input_text", text: VISION_LEAK_NUDGE }] });
              continue;
            }
            finalText =
              "Computer use ended without a usable final answer: the vision model emitted tool-call markup as text twice instead of acting or answering. " +
              `Harness facts for this session — steps ${steps}, refusedRepeats ${counters.refusedRepeats}, noChangeStrikes ${counters.noChangeStrikes}, degenerateFrames ${counters.degenerateFrames}` +
              `${counters.frameGeometry ? `, frame ${counters.frameGeometry}` : ""}. Anything already done on the ${selection.platform === 'windows' ? 'Windows PC' : 'Mac'} stands; retry the task, or narrow it.`;
            break;
          }
          finalText = text;
          break;
        }

        let terminal = false;
        for (const call of result.functionCalls) {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(call.arguments || "{}");
          } catch {
            args = {};
          }
          const action: ComputerAction = {
            name: call.name as ComputerAction["name"],
            x: typeof args.x === "number" ? args.x : undefined,
            y: typeof args.y === "number" ? args.y : undefined,
            button: args.button === "right" ? "right" : "left",
            clicks: args.clicks === 2 ? 2 : 1,
            text: typeof args.text === "string" ? args.text : undefined,
            key: typeof args.key === "string" ? args.key : undefined,
            modifiers: Array.isArray(args.modifiers)
              ? args.modifiers.map(String)
              : undefined,
            direction: args.direction === "up" ? "up" : "down",
            amount: typeof args.amount === "number" ? args.amount : undefined,
            target: typeof args.target === "string" ? args.target : undefined,
            // cu-diag fix #3: wait seconds (clamped when handled below).
            seconds: typeof args.seconds === "number" ? args.seconds : undefined,
            // W3 (Windows 0.9.0): UIA tool args — passed through the same
            // defensive-shape discipline as the core vocabulary.
            root: args.root === "desktop" ? "desktop" : undefined,
            max_depth: typeof args.max_depth === "number" ? args.max_depth : undefined,
            max_nodes: typeof args.max_nodes === "number" ? args.max_nodes : undefined,
            runtime_id: Array.isArray(args.runtime_id)
              ? args.runtime_id
                  .filter((n: unknown) => typeof n === "number" && Number.isFinite(n))
                  .map((n: number) => n)
              : undefined,
            pattern:
              args.pattern === "toggle" ||
              args.pattern === "expand" ||
              args.pattern === "select" ||
              args.pattern === "focus" ||
              args.pattern === "set_value"
                ? args.pattern
                : undefined,
            message:
              typeof args.message === "string" ? args.message : undefined,
            reasoning:
              typeof args.reasoning === "string" ? args.reasoning : undefined,
          };

          if (action.name === "done") {
            finalText = (action.message || "").trim() || "Done.";
            terminal = true;
            inputItems.push({
              type: "function_call",
              call_id: call.callId,
              name: call.name,
              arguments: call.arguments,
            });
            inputItems.push({
              type: "function_call_output",
              call_id: call.callId,
              output: '{"ok":true}',
            });
            break;
          }
          if (action.name === "ask_user") {
            askUserNote = (action.message || "").trim();
            finalText = askUserNote
              ? `I need you before I can finish: ${askUserNote}`
              : "I need your input to finish this task.";
            terminal = true;
            inputItems.push({
              type: "function_call",
              call_id: call.callId,
              name: call.name,
              arguments: call.arguments,
            });
            inputItems.push({
              type: "function_call_output",
              call_id: call.callId,
              output: '{"ok":true,"note":"run ending so the user can respond"}',
            });
            break;
          }

          // cu-diag fix #3: the `wait` tool — a bounded pause, then a fresh
          // screenshot, charged NO step (up to MAX_FREE_WAITS). Never reaches
          // the device as "wait": it becomes a plain screenshot below, so the
          // observe-only gate, the watchdog and the panel all see a read.
          let waitedSeconds: number | null = null;
          if (action.name === "wait") {
            waitedSeconds = clampWaitSeconds(action.seconds, deadline - Date.now());
            if (freeWaitsLeft > 0) {
              freeWaitsLeft--;
              steps--; // a wait is not a step
            }
            sendEvent("progress", { message: `Waiting ${waitedSeconds.toFixed(1)}s for the screen to settle${action.reasoning ? ` — ${action.reasoning.slice(0, 80)}` : ""}` });
            if (waitedSeconds > 0) await sleep(waitedSeconds * 1000);
            action.name = "screenshot";
            action.reasoning = action.reasoning || `after waiting ${waitedSeconds.toFixed(1)}s`;
          }

          // Degeneration guard (cu-diag fix #3 rewrite): identical INPUT action
          // 3× running → one nudge that costs NO step (up to MAX_FREE_NUDGES),
          // logged as "repeated-action nudged" (the old "wrapping" was a
          // misnomer — the loop never wrapped, it just refused the dispatch).
          // Reads (screenshot / uia_tree / wait) never form a signature.
          const sig = actionSignature(action);
          if (sig !== null) signatures.push(sig);
          if (sig !== null && repeatedSignature(signatures)) {
            counters.refusedRepeats += 1;
            const free = !degenerationGuardLegacy() && freeNudgesLeft > 0;
            if (free) {
              freeNudgesLeft--;
              steps--; // the nudge round is free
            }
            logger.warn(
              `computer loop: repeated-action nudged at step ${steps + (free ? 1 : 0)} (${action.name}${sig ? ` ${sig.slice(0, 80)}` : ""}) — identical action refused, model nudged${free ? " (no step consumed)" : ""}`,
            );
            inputItems.push({
              type: "function_call",
              call_id: call.callId,
              name: call.name,
              arguments: call.arguments,
            });
            inputItems.push({
              type: "function_call_output",
              call_id: call.callId,
              output:
                '{"ok":false,"error":"You have repeated the identical action 3 times with no new effect. STOP repeating: either try a different approach (a different target, keyboard navigation, or wait for the screen to settle) or call done with your best current answer."}',
            });
            signatures.length = 0;
            continue;
          }

          // Ticket 8fe9429c — the OBSERVE-ONLY dispatch gate. This is the
          // enforcement point (the tool list is only a hint): an input action
          // emitted by the vision model in an observe-only session is refused
          // HERE — it never reaches driver.execute, so nothing is dispatched
          // to the device. The refusal rides the model's own function_call_
          // output so it sees a hard capability limit, exactly like the
          // degeneration guard above.
          if (observeOnly && OBSERVE_REFUSED_ACTIONS.has(action.name)) {
            logger.warn(
              `computer loop: refused ${action.name} in observe-only session (step ${steps}) — input action never dispatched (ticket 8fe9429c)`,
            );
            inputItems.push({
              type: "function_call",
              call_id: call.callId,
              name: call.name,
              arguments: call.arguments,
            });
            inputItems.push({
              type: "function_call_output",
              call_id: call.callId,
              output: JSON.stringify({ ok: false, error: OBSERVE_ONLY_REFUSAL }),
            });
            continue;
          }

          const obs = await driver.execute(action);

          // cu-diag fix #1: focus split — the frontmost window is on a display
          // this frame does not show (agent ≥ 0.6.1 reports both ids).
          const split = focusSplit(obs);
          const splitWarning = split ? focusSplitNotice(obs) : "";
          // cu-diag fix #6: a MACHINE-triggered run re-checks owner presence
          // on every frame — the owner sitting down mid-run flips it to
          // camera-only for the rest of the session (one-way; the input tools
          // are withdrawn from the next vision call and the dispatch gate
          // above refuses anything the model still emits).
          let presenceGateWarning = "";
          if (!observeOnly && input.machineTriggered === true && obs.ok && obs.screenshotBase64) {
            const p = ownerPresence(obs);
            if (p.active) {
              observeOnly = true;
              instructions = composeInstructions(true);
              ownerPresenceResult = { active: true, reason: p.reason, gated: true };
              presenceGateWarning =
                `OWNER ACTIVE — CAMERA-ONLY from now on: the owner appears to be using this device (${p.reason}). ` +
                "Every further input action is refused; take screenshots to report what you see, then call done.";
              sendEvent("progress", { message: `Owner appears active mid-run (${p.reason}) — switching this machine-triggered run to camera-only.` });
              logger.info(`computer loop: owner-presence gate → observe-only mid-run (step ${steps}) for user ${userId} device ${drivenDeviceId} (${p.reason})`);
            }
          }

          // ── Write-path watchdog (ticket ac9022a0) ────────────────────────
          // CGEventPost returns void, so a click/type/key/scroll that macOS
          // silently drops (Accessibility revoked, broken event delivery,
          // stale viewport — pre-0.4.3 agents have NO delivery verification)
          // still reports ok:true and the loop reads "success". The
          // version-independent detector: the driver auto-screenshots after
          // every input action — a post-action frame BYTE-IDENTICAL to the
          // previous one proves the action changed nothing (a static screen
          // re-encodes deterministically; any pixel change — caret blink,
          // clock — yields different bytes, so this can only fail OPEN,
          // never accuse a working write path). One notice rides the
          // action's own result so the model re-grounds and changes
          // approach; NO_CHANGE_LIMIT consecutive no-change input actions
          // end the task LOUDLY instead of burning the whole step budget in
          // a silent retry loop (the 2026-09-21 incident: 12 steps, zero
          // mutations, no signal — twice, on two independent lanes).
          const mutatingInput =
            action.name === "click" ||
            action.name === "type" ||
            action.name === "key" ||
            action.name === "scroll";
          // 6f4f8b36: hoist the grade — both watchdogs grade the same frame.
          // cu-diag fix #4: the grade is the DECODED readability metric (dark
          // Terminal = readable, so byte-identity dead-input detection stays
          // ARMED on dark screens); bpp is only the undecodable fallback.
          const obsGrade = obs.screenshotBase64 ? gradeFrame(obs) : null;
          const obsBpp = obsGrade?.bpp ?? 0;
          // 6f4f8b36 (RC1) — VERIFIABILITY GATE: a byte-identity comparison is
          // only dead-INPUT evidence when BOTH legs are READABLE captures.
          // The incident (2026-09-25, owner watching live): a broken capture
          // path (solid/black frames after a Screen Recording grant — macOS
          // serves new grants only to a freshly launched process, ticket
          // 33401f39) compares blank-vs-blank, finds pixel-identical, and the
          // old code graded each healthy input action as a strike, then
          // aborted with "input is not landing" while Spotlight opened on the
          // owner's screen. A dead capture path must be reported as a CAPTURE
          // problem (the 33401f39 advisory does that on this same
          // observation), never as dead input.
          const baselineVerifiable = !!lastShotB64 && !!lastFrameGrade && lastFrameGrade.readable;
          const postVerifiable = obs.ok && !!obs.screenshotBase64 && !!obsGrade && obsGrade.readable;
          // cu-diag fix #5: the harness states the diff ITSELF (bytes / pixel
          // % / frontmost / display) — the model never infers it.
          const harnessDiff = describeFrameDiff({
            prevB64: lastShotB64,
            nextB64: obs.screenshotBase64,
            prevMetrics: lastFrameGrade?.metrics ?? null,
            nextMetrics: obsGrade?.metrics ?? null,
            prevApp: lastFrontmost,
            nextApp: obs.frontmostApp,
            ...obsGeometry(obs),
            ...(obsGeometry(obs).displayCount === undefined ? { displayCount: lastGeometry.displayCount } : {}),
          });
          // cu-diag fix #2 (a): a frontmost-app change since the previous
          // frame is POSITIVE evidence input was delivered — the incident's
          // "(C) INPUT DEAD" verdict was falsified by its own frontmost field
          // (Terminal → TextEdit on byte-identical frames: the app opened on a
          // display the agent was not capturing).
          const frontmostChanged =
            !!obs.frontmostApp && !!lastFrontmost && obs.frontmostApp !== lastFrontmost;
          let noChangeWarning = "";
          let inputEvidenceNote = "";
          let noChangeAdvisory = false;
          if (mutatingInput && obs.ok && !obs.screenshotBase64) {
            // The action ran but the camera didn't (driver's "follow-up
            // screenshot failed" note) — inconclusive, never a strike. The
            // consecutive chain is broken, so the streak cannot ride a
            // blackout into a false abort after recovery.
            noChangeStreak = 0;
          }
          if (mutatingInput && obs.ok && obs.screenshotBase64 && lastShotB64) {
            if (obs.screenshotBase64 === lastShotB64) {
              if (frontmostChanged) {
                // Outranks the focus-split hold below: the split says WHERE
                // the effect went; the frontmost change proves the input got
                // there (the incident's own signature — both notices ride).
                counters.frontmostChanges += 1;
                noChangeStreak = 0;
                inputEvidenceNote =
                  `INPUT DELIVERED — the frontmost app changed ${lastFrontmost}→${obs.frontmostApp} even though the captured frame is byte-identical: your ${action.name} landed, but its effect is on a display or window the capture is not showing. Continue; prefer keyboard-driven steps and read the harness line for what the camera actually sees.`;
              } else if (split) {
                // cu-diag fix #1: the frontmost window is on a display this
                // frame does not show — an unchanged frame of the WRONG
                // display proves nothing about input delivery (the 2026-09-25
                // incident: every keystroke landed on the Dell while the
                // built-in panel was captured). No strike; the streak HOLDS.
                // The [FOCUS ON UNCAPTURED DISPLAY] notice rides this
                // observation instead.
              } else if (baselineVerifiable && postVerifiable && !noOpProneKey(action)) {
                // cu-diag fix #2 (b): a no-op CLICK is ADVISORY, like a no-op
                // key — the 18:10Z false abort was three clicks into an
                // already-open Finder window with the target already selected
                // (the CORRECT outcome is "nothing changes"). type / modifier
                // keys / scroll stay strike-eligible; the harness probe below
                // is the arbiter of a genuinely dead write path.
                const advisoryClick = action.name === "click" && !clickStrikesLegacy();
                if (advisoryClick) {
                  noChangeAdvisory = true;
                  noChangeWarning =
                    `NO VISIBLE CHANGE (advisory) — the screen is pixel-identical after this click. ` +
                    "Clicking an already-selected or inert target legitimately changes nothing, so this is NOT counted as a dead-input strike — but do not repeat the same click: re-ground with ONE screenshot, then change approach (a different target, or keyboard navigation).";
                } else {
                  noChangeStreak += 1;
                  counters.noChangeStrikes += 1;
                  noChangeWarning =
                    `NO VISIBLE CHANGE — the screen is pixel-identical after this ${action.name} (${noChangeStreak} consecutive). ` +
                    (inputProven
                      ? "Input on this device is PROVEN to land (a harness probe changed the screen earlier this session), so this action simply had no visible effect where the camera looks — or its effect is on a display not being captured. "
                      : "The input may not be reaching the screen (Accessibility permission revoked for the Digby Mac app, macOS dropping synthetic input, or a stale viewport) — or this action may simply have had no visible effect. ") +
                    "Do NOT repeat the same action: re-ground with ONE screenshot, then change approach (keyboard navigation or a different target). " +
                    (inputProven
                      ? ""
                      : "If another input action that should visibly change the screen also changes nothing, the harness will run its own positive-control probe before any verdict is drawn; call done and report the task BLOCKED by input delivery only if the harness says the probe failed.");
                }
              } else if (!baselineVerifiable || !postVerifiable) {
                // A degenerate/blank capture leg: no strike, and the streak
                // RESETS — a broken camera must not be graded as dead input,
                // and its recovery must not inherit strikes scored before
                // the break (the capture window is transient; a relaunch of
                // the Mac app fixes it — the 33401f39 advisory on this
                // observation carries that remedy to the model).
                noChangeStreak = 0;
              }
              // else: 6f4f8b36 (RC2) — a no-op-prone key (bare escape/tab/
              // arrows/home/end/pageup/pagedown) left the screen identical:
              // the EXPECTED outcome of such a key is often "nothing happens"
              // on a perfectly healthy Mac, so this is not strike evidence.
              // The streak HOLDS: genuinely dead clicks around it still
              // accumulate, so a real dead write path is still caught.
            } else {
              noChangeStreak = 0; // a proven visible change resets the streak
            }
          }
          // Degenerate-frame watchdog (ticket 33401f39 → cu-diag fix #4): the
          // same unreadable class can appear MID-TASK (permission revoked
          // mid-run, display asleep, helper wedged after a wake). The caution
          // fires ONCE per low-readability streak (the incident run got 44 of
          // them on readable dark frames, ending in "call done NOW" — that
          // escalation is gone). The MODEL, which sees the frame, decides.
          let degenerateWarning = "";
          if (obs.ok && obsGrade && !obsGrade.readable && (obsGrade.basis === "metric" || obsBpp > 0)) {
            degenerateStreak += 1;
            counters.degenerateFrames += 1;
            if (degenerateStreak === 1) {
              degenerateWarning =
                `LOW-READABILITY FRAME (${obsGrade.detail}) — this is either an unreadable solid capture or a dark/quiet real screen. ` +
                "LOOK at the frame: if it is a flat solid with no UI at all, say so in your done message with the quit-and-relaunch fix for the user (⌘Q the Digby Mac app, reopen it, then retry); if it is a readable dark screen, continue normally. This caution will not repeat while the frames stay low.";
            }
          } else if (obsGrade && obsGrade.readable) {
            degenerateStreak = 0; // a readable frame resets the streak
          }
          if (obs.screenshotBase64) {
            lastShotB64 = obs.screenshotBase64;
            lastShotBpp = obsBpp; // 6f4f8b36: the next comparison gates on this leg too
            lastFrameGrade = obsGrade;
            noteGeometry(obs);
          }
          if (obs.frontmostApp) lastFrontmost = obs.frontmostApp;
          // cu-diag fix #3: repeated screenshots are no longer refused; a run
          // of byte-identical explicit screenshots gets a soft steer to wait.
          // Review follow-up (2026-09-25): a screenshot produced by `wait`
          // neither advances nor resets the run (the model just DID wait —
          // telling it to "use the wait tool" would be nonsense).
          let identicalShotNote = "";
          if (action.name === "screenshot" && obs.screenshotBase64 && waitedSeconds === null) {
            identicalShotRun = harnessDiff.startsWith("bytes identical") ? identicalShotRun + 1 : 0;
            if (identicalShotRun >= 2) {
              identicalShotNote = `The last ${identicalShotRun + 1} screenshots are byte-identical — if you are waiting for something to appear, use the wait tool; otherwise act or call done.`;
            }
          } else if (action.name !== "screenshot") {
            identicalShotRun = 0;
          }

          // The strike count AS SCORED for this action — the probe below may
          // reset the streak, but the outcome reports what this action scored.
          const strikeAtAction = noChangeStreak;

          // ── cu-diag fix #2 (c): HARNESS POSITIVE-CONTROL PROBE ─────────────
          // At PROBE_AT_STRIKES consecutive strikes the harness itself sends a
          // known-visible input (Cmd+Space opens Spotlight; Escape closes it)
          // and judges the write path from ITS OWN frames: a changed frame or
          // a changed frontmost app proves input lands (strikes reset, the
          // session continues, later strikes annotate but never abort); an
          // identical frame with an unchanged frontmost is the only evidence
          // on which the session aborts. macOS + full-input sessions only.
          // Review fix (2026-09-25): the probe is gated on "THIS action scored
          // a strike" (never on the standing streak — an inconclusive probe
          // used to re-fire on every later screenshot / wait / Escape), on a
          // fresh streak level, and on a per-session attempt budget: probe at
          // strike 2; if that was inconclusive, retry once at strike 3 (right
          // before the legacy abort below); never more.
          const strikeScored = !!noChangeWarning && !noChangeAdvisory;
          if (noChangeStreak < probedAtStreak) probedAtStreak = 0; // the streak reset since the last probe
          let probeNote = "";
          let probeFailed = false;
          let probeFrame: ComputerObservation | null = null;
          if (
            strikeScored &&
            noChangeStreak >= PROBE_AT_STRIKES &&
            noChangeStreak > probedAtStreak &&
            counters.probesRun < MAX_PROBE_ATTEMPTS &&
            !inputProven &&
            !observeOnly &&
            selection.platform !== "windows"
          ) {
            probedAtStreak = noChangeStreak;
            counters.probesRun += 1;
            const preB64 = lastShotB64;
            const preApp = lastFrontmost;
            try {
              sendEvent("progress", { message: "Input watchdog: running a harness positive-control probe (Cmd+Space, then Escape) before drawing any verdict." });
              const p1 = await driver.execute({ name: "key", key: "space", modifiers: ["cmd"], reasoning: "harness positive-control probe" });
              const p1Changed =
                (!!p1.screenshotBase64 && !!preB64 && p1.screenshotBase64 !== preB64) ||
                (!!p1.frontmostApp && !!preApp && p1.frontmostApp !== preApp);
              const p1Grade = p1.screenshotBase64 ? gradeFrame(p1) : null;
              const p1Pct = frameDiffPercent(lastFrameGrade?.metrics ?? null, p1Grade?.metrics ?? null);
              const p2 = await driver.execute({ name: "key", key: "escape", reasoning: "harness probe cleanup" });
              probeFrame = p2.screenshotBase64 ? p2 : p1.screenshotBase64 ? p1 : null;
              if (p1.ok && p1.screenshotBase64 && p1Changed) {
                counters.probesPassed += 1;
                inputProven = true;
                counters.inputProven = true;
                noChangeStreak = 0;
                probeNote =
                  `HARNESS POSITIVE CONTROL PASSED — the harness pressed Cmd+Space and the screen changed (${p1Pct !== null ? `${p1Pct}% of pixels` : "bytes differ"}${p1.frontmostApp && preApp && p1.frontmostApp !== preApp ? `, frontmost ${preApp}→${p1.frontmostApp}` : ""}), then Escape. Input IS landing on this device: your recent actions simply had no visible effect where the camera looks. Change approach (different target, keyboard navigation); the input-delivery hypothesis is closed.`;
                sendEvent("computer-observation", { action: "probe", ok: true, driver: "computer", app: p1.frontmostApp, preview: `harness probe: Cmd+Space changed the screen — input lands (${p1Pct !== null ? `${p1Pct}% pixels` : "bytes differ"})` });
              } else if (p1.ok && p1.screenshotBase64) {
                probeFailed = true;
                sendEvent("computer-observation", { action: "probe", ok: false, driver: "computer", app: p1.frontmostApp, preview: "harness probe: Cmd+Space produced an identical frame with an unchanged frontmost app" });
              } else {
                // Probe inconclusive (dispatch refused / no frame) — no verdict.
                // The streak stands; the probe is retried at most once, on the
                // next genuine strike (never on a read / wait / no-op key).
                sendEvent("computer-observation", { action: "probe", ok: false, driver: "computer", preview: `harness probe inconclusive: ${p1.error || "no frame"}` });
              }
              if (probeFrame?.screenshotBase64) {
                lastShotB64 = probeFrame.screenshotBase64;
                lastFrameGrade = gradeFrame(probeFrame);
                lastShotBpp = lastFrameGrade.bpp;
                if (probeFrame.frontmostApp) lastFrontmost = probeFrame.frontmostApp;
                noteGeometry(probeFrame);
              }
            } catch (e: any) {
              logger.warn(`computer loop: harness positive-control probe failed to dispatch: ${e?.message || e}`);
              sendEvent("computer-observation", { action: "probe", ok: false, driver: "computer", preview: `harness probe could not run: ${e?.message || e}` });
            }
          }

          sendEvent("computer-observation", {
            action: action.name,
            ok: obs.ok,
            driver: "computer",
            app: obs.frontmostApp,
            preview: obs.error
              ? `⚠️ ${obs.error}`
              : split
                ? `⚠️ ${action.name} — focus on uncaptured display ${obs.frontmostWindowDisplayId} (captured ${obs.displayId})`
                : inputEvidenceNote
                  ? `${action.name} — frontmost changed ${harnessDiff ? `(${harnessDiff})` : ""}`
                  : noChangeWarning
                    ? `⚠️ ${action.name} — no visible change${noChangeAdvisory ? " (advisory)" : ` (${strikeAtAction})`}`
                    : degenerateWarning
                      ? `⚠️ ${action.name} — low-readability frame (${degenerateStreak})`
                      : `${action.name} done${waitedSeconds !== null ? ` (after ${waitedSeconds.toFixed(1)}s wait)` : ""}`,
            reasoning: action.reasoning,
            // cu-diag fix #1: per-frame geometry + display facts on the event
            // (the harness now RECORDS them; the incident's geometry leg was
            // narration-only).
            ...observationGeometry(obs),
            ...(split ? { focusSplit: true } : {}),
            ...(noChangeWarning && !noChangeAdvisory ? { noVisibleChange: strikeAtAction } : {}),
            ...(noChangeAdvisory ? { noVisibleChangeAdvisory: true } : {}),
            ...(degenerateWarning ? { degenerateFrame: degenerateStreak } : {}),
            ...(presenceGateWarning ? { ownerPresenceGated: true } : {}),
            // cu-diag fix #5: the harness-measured diff rides the event too.
            ...(harnessDiff ? { harness: harnessDiff } : {}),
          });
          if (obs.screenshotBase64) {
            // live:true — the panel refreshes its screen view without logging a
            // separate "screenshot" row (the action above IS the log row).
            sendEvent("computer-observation", screenshotFrame(obs, true));
          }
          if (probeFrame?.screenshotBase64) {
            sendEvent("computer-observation", screenshotFrame(probeFrame, true));
          }

          // Feed back: echo the call, then the textual outcome, then (when we have
          // one) the fresh screenshot as a new user image message.
          inputItems.push({
            type: "function_call",
            call_id: call.callId,
            name: call.name,
            arguments: call.arguments,
          });
          // W3 (Windows 0.9.0): a uia_tree observation carries the compact
          // accessibility-tree TEXT instead of a screenshot — the tree IS the
          // observation. Like screenshots, only the LATEST tree is kept in the
          // input: older trees are replaced with a one-line placeholder so a
          // 300-node walk every step doesn't bloat the context.
          const isTreeObservation = action.name === "uia_tree" && obs.ok && typeof obs.text === "string";
          const outcome = isTreeObservation
            ? JSON.stringify({
                ok: true,
                node_count: obs.node_count ?? 0,
                // The full tree rides the user message below (a text block,
                // where the model reads it as content, not as a tool-result
                // blob); the tool result stays a compact receipt.
              })
            : obs.ok
              ? JSON.stringify({
                  ok: true,
                  note: obs.error || undefined,
                  ...(waitedSeconds !== null ? { waited: Number(waitedSeconds.toFixed(1)) } : {}),
                  // cu-diag fix #5: the harness-measured diff rides EVERY
                  // outcome ("bytes identical / N% of pixels changed /
                  // frontmost changed A→B / display M of K").
                  ...(harnessDiff ? { harness: harnessDiff } : {}),
                  ...(inputEvidenceNote ? { inputDelivered: true, note: inputEvidenceNote } : {}),
                  ...(noChangeWarning && !noChangeAdvisory
                    ? { noVisibleChange: strikeAtAction, warning: noChangeWarning }
                    : {}),
                  ...(noChangeAdvisory
                    ? { noVisibleChangeAdvisory: true, warning: noChangeWarning }
                    : {}),
                  ...(degenerateWarning
                    ? { degenerateFrame: degenerateStreak, warning: degenerateWarning }
                    : {}),
                  // cu-diag fix #1 / #6: the focus-split notice and the
                  // mid-run presence gate ride the action's own result so
                  // the model reads them BEFORE the next frame.
                  ...(splitWarning ? { focusSplit: splitWarning } : {}),
                  ...(presenceGateWarning ? { ownerActive: presenceGateWarning } : {}),
                  ...(identicalShotNote ? { hint: identicalShotNote } : {}),
                  ...(probeNote ? { harnessProbe: probeNote } : {}),
                })
              : JSON.stringify({
                  ok: false,
                  // Agent refusals ('UIA_E_ELEVATED: ...') arrive as the error
                  // string — forwarded VERBATIM (never paraphrased away): the
                  // Windows instructions tell the model these codes arrive.
                  error: obs.error || "action failed",
                });
          inputItems.push({
            type: "function_call_output",
            call_id: call.callId,
            output: outcome,
          });
          if (isTreeObservation) {
            stripOlderTrees(inputItems);
            inputItems.push({
              role: "user",
              content: [
                {
                  type: "input_text",
                  text:
                    `Accessibility tree of the ${action.root === "desktop" ? "desktop" : "frontmost window"} after "uia_tree" (${obs.node_count ?? 0} nodes — element runtime_ids are in brackets; use uia_invoke to activate one).` +
                    "\n\n" +
                    obs.text,
                },
              ],
            });
          }
          // The frame the model sees next: the post-probe frame when a harness
          // probe ran (the screen after Escape is the current state), else
          // the action's own auto-screenshot.
          const frameForModel = probeFrame?.screenshotBase64 && probeFrame.imageWidth && probeFrame.imageHeight ? probeFrame : obs;
          if (frameForModel.screenshotBase64 && frameForModel.imageWidth && frameForModel.imageHeight) {
            stripOlderImages(inputItems);
            inputItems.push(
              userImageMessage(
                `Screenshot after "${action.name}"${frameForModel === probeFrame ? " and the harness probe" : ""} (${frameForModel.imageWidth}×${frameForModel.imageHeight} px — click in THIS pixel space).` +
                  (typeof frameForModel.displayId === "number" ? ` Captured display ${frameForModel.displayId}${typeof frameForModel.displayCount === "number" ? ` of ${frameForModel.displayCount}` : ""}.` : "") +
                  (harnessDiff ? ` Harness measured after "${action.name}": ${harnessDiff}.` : "") +
                  (splitWarning ? `\n\n${splitWarning}` : "") +
                  (presenceGateWarning ? `\n\n${presenceGateWarning}` : ""),
                frameForModel.screenshotBase64,
              ),
            );
          }

          // Write-path watchdog termination (ticket ac9022a0): NO_CHANGE_LIMIT
          // consecutive provably-dead input actions — stop burning the step
          // budget and end with a LOUD blocked report + the fix, instead of a
          // silent 12-step retry loop that reports nothing.
          // cu-diag fix #2 (c)+(d): the session aborts on ONE of two grounds —
          //   • the harness positive-control probe FAILED (Cmd+Space produced an
          //     identical frame with an unchanged frontmost app), or
          //   • the probe could not run (kill switch / Windows / observe-only)
          //     or was INCONCLUSIVE on both of its attempts (strike 2 + the
          //     strike-3 retry) and the legacy NO_CHANGE_LIMIT is reached —
          // and never once a probe has PASSED this session (inputProven).
          const legacyAbort = noChangeStreak >= NO_CHANGE_LIMIT && !inputProven;
          if (probeFailed || legacyAbort) {
            // 6f4f8b36 (d): the verdict is UNVERIFIABLE input, not proven-dead
            // input — the copy names the possible causes (input delivery AND
            // capture) and never asserts what it could not verify. Platform
            // noun/fix follow the W1 branch idiom (a Windows abort must not
            // prescribe macOS System Settings). The copy names the ACTUAL
            // agent version and the uncaptured-display possibility (the
            // incident: TextEdit opened on a display the agent did not
            // capture while the old copy blamed permissions + "older than
            // v0.4.3").
            const noun = selection.platform === 'windows' ? 'Windows PC' : 'Mac';
            const agentVer = selection.agentVersion ? `v${selection.agentVersion}` : "unknown version";
            const geometry = counters.frameGeometry ? ` (frames ${counters.frameGeometry}${counters.displayCount !== null ? `, ${counters.displayCount} display${counters.displayCount === 1 ? "" : "s"} reported` : ""})` : "";
            finalText =
              `Computer use stopped: ${noChangeStreak} consecutive input actions produced no visible change on your ${noun} — the screen was pixel-identical after each, on verifiable screenshots (last attempted: ${action.name})${geometry}. ` +
              (probeFailed
                ? "The harness then ran its own positive-control probe (Cmd+Space, then Escape) and that ALSO produced a byte-identical frame with an unchanged frontmost app. "
                : counters.probesRun > 0
                  ? `The harness tried its own positive-control probe (Cmd+Space, then Escape) ${counters.probesRun === 1 ? "once" : `${counters.probesRun} times`} but it was inconclusive (the keystroke was refused or no frame came back), so it could not settle whether input lands. `
                  : "") +
              "The actions were dispatched, but their effect on the screen could not be verified. " +
              (selection.platform === 'windows'
                ? "This usually means synthetic input is not landing — an elevated (administrator) window ignores synthetic input from a normal app (UIPI), or input delivery is failing. "
                : `Two explanations fit: synthetic input is not landing (the Accessibility permission for the Digby Mac app revoked, or macOS dropping synthetic input), OR the input IS landing but the app is on a display I am not capturing (the Mac agent ${agentVer} captures one display; a closed lid, an external monitor or a Screen Sharing virtual display can put the active window elsewhere). `) +
              `Nothing on the ${noun} was verifiably changed by this run. ` +
              (selection.platform === 'windows'
                ? "On the PC: make sure the window you are driving is not elevated (click it yourself once, or rerun the task from a non-admin window), update the Digby desktop app, then retry the task."
                : `On the Mac: first check the display setup (one display, or make the display you work on the main one), and confirm the Digby Mac app is ${agentVer} or newer; only if the screen layout is already single-display, check System Settings → Privacy & Security → Accessibility for the Digby app, then retry the task.`);
            sendEvent("progress", {
              message: `Input watchdog: ${noChangeStreak} consecutive no-visible-change actions${probeFailed ? " and a failed harness positive-control probe" : ""} — stopping with a blocked report.`,
            });
            logger.warn(
              `computer loop: write-path watchdog terminated the session at step ${steps} (${noChangeStreak} consecutive no-visible-change input actions, last ${action.name}${probeFailed ? ", harness probe failed" : ", probe unavailable"}) — input delivery unverifiable (ticket ac9022a0 / cu-diag fix #2)`,
            );
            terminal = true;
            break;
          }

          // Degenerate-frame watchdog (ticket 33401f39): ADVISORY-ONLY. The
          // observation above already carries the low-density caution; the
          // model — which SEES each frame — decides whether to call done.
          // No code-level termination: sparse-but-real dark screens overlap
          // the solid band (PR #1030 review B1 + follow-up: a density-only
          // stop killed legitimate dark-desktop sessions one frame in, with
          // the wrong quit-and-relaunch remedy as the final answer). The
          // write-path watchdog above (byte-identical after input actions)
          // remains the only mid-task code stop — it is proven-dead-INPUT
          // evidence, a different class.
        }

        if (terminal) break;
      }
    } catch (e: any) {
      logger.warn(`computer loop crashed (step ${steps}): ${e?.message || e}`);
      if (!finalText)
        finalText = `Computer use hit an internal error mid-task (${e?.message || e}). Actions already taken on the Mac stand — retry the task.`;
    }

    // Ran out of steps / hit the deadline without an answer → force a wrap-up.
    if (!finalText) {
      try {
        stripOlderImages(inputItems);
        inputItems.push({
          role: "user",
          content: [
            // Wrap-up re-quote rides the same never-silent rule (24afad95):
            // 16K cap + explicit marker when exceeded.
            {
              type: "input_text",
              text: `Answer the ORIGINAL task now: "${taskLine}". Summarize concretely what you did and saw, and anything left for the user. Do NOT narrate next steps.`,
            },
          ],
        });
        const wrap = await visionChat({
          instructions,
          input: inputItems,
          reasoningEffort: "low",
          maxTokens: 2048,
          timeout: 60000,
        });
        const wrapText = wrap.text.trim();
        // cu-diag fix #5: the wrap-up is a plain-text answer by construction
        // (no tools offered) — leaked markup here is still never the answer.
        finalText =
          (looksLikeVisionSeatLeak(wrapText) ? "" : wrapText) ||
          "The computer-use session ended without a final answer. Retry the task, or narrow it.";
      } catch (e: any) {
        finalText =
          "The computer-use session ended without a final answer (wrap-up vision call failed). Retry the task, or narrow it.";
      }
    }

    sendEvent("chunk", { content: finalText });
    counters.inputProven = inputProven;
    return {
      finalResponse: finalText,
      elapsed: Date.now() - started,
      steps,
      localStatus: selection.status,
      ...(selection.device ? { device: selection.device } : {}),
      ...selectionDeviceFlags(),
      ...(observeOnly ? { observeOnly: true } : {}),
      // cu-diag fix #6: the presence verdict (and whether it gated this run)
      // is surfaced only when the agent reported presence facts or the gate
      // acted — older agents leave the result shape byte-identical.
      ...(ownerPresenceResult.active || ownerPresenceResult.gated ? { ownerPresence: ownerPresenceResult } : {}),
      // cu-diag fix #3: harness-measured counters for the tool-result header.
      harness: counters,
    };
  } finally {
    // Always drop the per-device lock — the compare-and-delete release makes a
    // successor's lock (taken after our TTL lapsed) safe from us.
    await releaseComputerUseLock(userId, lockToken, drivenDeviceId ?? undefined);
  }
}
