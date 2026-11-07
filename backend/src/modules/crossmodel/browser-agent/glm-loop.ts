/**
 * GLM-5.3 browser reasoning loop (open-source only, reasoning_effort:"high").
 *
 * GLM-5.3 is given the driver-agnostic browser action vocabulary as OpenAI tools and
 * drives the page step by step: navigate → read → reason → click/type → read → … →
 * done. The chosen driver (cloud BrightData or the user's local Mac) is selected by
 * the router; this loop is identical regardless of which backend executes the actions.
 *
 * SSE surfaced to the UI (all additive, controller passes sendEvent through):
 *   progress           — routing decision + step narration
 *   browser-observation — {action, ok, url, preview, reasoning} after each action,
 *                         plus a live-view frame {action:'screenshot', live:true,
 *                         screenshotBase64, mime} captured by the driver after every
 *                         action purely for the browser panel (2026-09-09)
 *   confirm            — {action, selector, text, reasoning} before a state-changing act
 *   ask_user           — {message} when the model needs the user to decide/clarify
 *   chunk              — final answer text (streamed), then controller emits complete
 */

import logger from '../../../utils/logger';
import { selectBrowserDriver, selectLocalFallbackDriver, freshLocalBrowserStatus, BrowserDriverSelection } from './router';
import { webSearchMissingOnInstance } from '../platform/instance-setup';
import { glmChat, GlmMessage, stripThink } from './glm-client';
import {
  BrowserAction,
  BrowserActionName,
  BrowserAgentInput,
  BrowserAgentResult,
  BrowserObservation,
  STATE_CHANGING_ACTIONS,
} from './types';

const MAX_STEPS = 12;

export const BROWSER_TOOL_SCHEMA = [
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Open a URL in the browser. Always navigate before reading or interacting with a page.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL to open (include https://).' },
          reasoning: { type: 'string', description: 'One short sentence on why you are navigating here.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_content',
      description: 'Read the current page. format="text" for readable text, "html" for markup, "snapshot" for text + links to decide where to click next.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['text', 'html', 'snapshot'] },
          reasoning: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click',
      description: 'Click an element. On the local browser use a CSS selector or visible text; on the cloud browser pass the element "ref" from a snapshot (call get_content format="snapshot" first).',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Local browser: CSS selector or visible link/button text.' },
          ref: { type: 'string', description: 'Cloud browser: element ref from a snapshot (e.g. "e12").' },
          reasoning: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'type',
      description: 'Type text into an input field. Local browser: pass a CSS "selector" (and submit=true to press Enter). Cloud browser: pass the input\'s "ref" from a snapshot.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'Local browser: CSS selector of the input.' },
          ref: { type: 'string', description: 'Cloud browser: input ref from a snapshot (e.g. "e7").' },
          text: { type: 'string' },
          submit: { type: 'boolean', description: 'Local browser only: press Enter after typing.' },
          reasoning: { type: 'string' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Scroll the page to reveal more content.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
          amount: { type: 'number', description: 'Pixels to scroll (optional).' },
          reasoning: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Capture a screenshot of the current page (use only when visual layout matters).',
      parameters: { type: 'object', properties: { reasoning: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extract',
      description: 'Read the current page text so you can extract specific information from it.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'What to extract from the page.' },
          reasoning: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Ask the user a question when you genuinely cannot proceed without their input (e.g. ambiguous choice, a login/2FA they must complete). Ends the session.',
      parameters: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Finish the task and give the user the final answer. Call this when you have what you need.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The complete final answer for the user.' },
          // Ticket ccd634fb: the hard "interaction unavailable" banner rides the result only when the
          // read-only limit actually bit — a refused click/type, or this flag.
          needs_interaction: { type: 'boolean', description: 'true when part of the task needed clicks, typing, scrolling or a login that this session could not do (so that part is NOT done). Omit or false when reading pages was enough.' },
        },
        required: ['message'],
      },
    },
  },
];

function buildSystemPrompt(driverKind: 'cloud' | 'local' | 'hosted', readOnlyCeiling = false, attachRequested = false): string {
  if (driverKind === 'hosted') {
    // Hosted hardened browser (ea3ad8a8) — review H3: a hosted session must NOT
    // get the BrightData ref-based cloud prompt (the hosted driver takes CSS
    // selectors, and its snapshot degrades to text). Selector-driven, like local.
    return (
      "You are Digby operating a web browser to accomplish the user's task. You are driving " +
      "Digby's own hosted browser: a real Chromium in Digby's cloud with its OWN persistent " +
      'cookies/localStorage for this session — wherever you (or the user) logged in during this ' +
      'chat stays signed in for later tasks in the SAME chat. It is NOT the user\u2019s everyday ' +
      'browser and does not carry their existing logins. In anything the user may read (done, ' +
      'ask_user), always call it "Digby\u2019s hosted browser" — never "your browser". ' +
      'You CAN click, type, and scroll.\n\n' +
      'Work in small steps: navigate, read the page (get_content), reason about what you see, ' +
      'then act (click/type/scroll). After each action, read the result before the next step. ' +
      'Interact with real CSS selectors (the hosted browser takes selectors, NOT BrightData refs). ' +
      'Prefer reading text over screenshots (the user already sees a live screenshot of every ' +
      'step in their side panel).\n\n' +
      'Be efficient — you have a limited number of steps. When you have enough to answer, call done with a ' +
      'complete, well-written answer (summarize what you found; include key links/values). ' +
      'If a page needs a login this session does not have, call ask_user ONCE with the login URL — ' +
      'the user signs in through the popped-out view and the login persists for future tasks in this chat. ' +
      "If the task requires the user's EXISTING everyday browser session or a desktop app, say so " +
      'plainly in done (Digby can use computer use — their real screen — instead). ' +
      'Only call ask_user if you truly cannot continue without the user (e.g. a login or 2FA only they can do). ' +
      'If a page presents a CAPTCHA / human-verification challenge, do NOT retry it and never attempt to ' +
      'bypass or solve it — call done with a short report that the page is CAPTCHA-blocked, including ' +
      'anything you gathered before the challenge.'
    );
  }
  if (driverKind === 'local') {
    return (
      "You are Digby operating a web browser to accomplish the user's task. You are driving " +
      "Digby's own browser on the user's Mac: a persistent Digby browser profile that stays signed in " +
      'wherever the user logged in THROUGH Digby before — it is NOT their everyday Chrome/Safari ' +
      'profile and does not carry those logins. In anything the user may read (done, ask_user), always call it ' +
      '"Digby\'s separate browser profile on your Mac" — never "your real browser" or just "not headless" ' +
      '(feedback 88915954). You CAN click, type, and scroll.\n\n' +
      (attachRequested
        ? 'THIS SESSION requested CDP-attach mode (the user asked for their OWN Chrome, ticket 4258335e). ' +
          'Every observation reports the ACTUAL mode: mode "attached" = a dedicated NEW TAB of the user\'s ' +
          'EVERYDAY Chrome on their Mac (their real signed-in profile — call it exactly that, never "Digby\'s ' +
          'profile"); mode "digby-profile" = the attach was unavailable (Chrome not launched with the debugging ' +
          'port, owner switch off, or old agent) and Digby\'s separate profile is driving — say so plainly if ' +
          'they asked for their own Chrome. In attached mode two safety rails HARD-REFUSE with a REFUSED error: ' +
          'typing into password/credential fields, and submitting forms (submit buttons, Enter-to-submit) — if ' +
          'the task needs one, finish what you can and explain the rail in done.\n\n'
        : '') +
      'Work in small steps: navigate, read the page (get_content/snapshot), reason about what you see, ' +
      'then act (click/type/scroll). After each action, read the result before the next step. ' +
      'Prefer reading text/snapshots over screenshots (the user already sees a live screenshot of every ' +
      'step in their side panel). Use real CSS selectors or visible link/button text.\n\n' +
      'Be efficient — you have a limited number of steps. When you have enough to answer, call done with a ' +
      'complete, well-written answer (summarize what you found; include key links/values). ' +
      'If a page needs a login this profile does not have, call ask_user ONCE — the browser window pops ' +
      'out on their Mac so they can sign in, and the login persists for future tasks. If the task really ' +
      "requires the user's EXISTING everyday browser session or a desktop app, say so plainly in done " +
      '(Digby can then use computer use — their real screen — instead). ' +
      'Only call ask_user if you truly cannot continue without the user (e.g. a login or 2FA only they can do). ' +
      'If a page presents a CAPTCHA / human-verification challenge, do NOT retry it and never attempt to ' +
      'bypass or solve it — call done with a short report that the page is CAPTCHA-blocked, including ' +
      'anything you gathered before the challenge.'
    );
  }
  let prompt =
    "You are Digby browsing the web to accomplish the user's task, using BrightData's cloud " +
    'browser (proxies + anti-bot handling).\n\n' +
    'Flow: navigate to a URL, then read it with get_content (format="text") or get_content ' +
    'format="snapshot" — the snapshot lists interactive elements with a "ref" for each. To click or ' +
    'type, pass that ref (click {ref}, type {ref, text}). Re-snapshot after the page changes to get ' +
    'fresh refs. You can also follow a link by navigating to its URL directly.\n\n' +
    'If the live browser session is unavailable, interactive steps will say so and you will be reading ' +
    'pages only (follow links by navigating to their URLs); if a task then truly needs clicks/typing or ' +
    'a logged-in session, say so in your answer and call done with needs_interaction=true (the user can ' +
    'connect their own Mac browser).\n\n' +
    'Work in small steps and reason about what you see. Be efficient — limited steps. When you have ' +
    'enough, call done with a complete, well-written answer (summarize findings; include key links/' +
    'values). Only call ask_user if you genuinely cannot proceed. ' +
    'If a page presents a CAPTCHA / human-verification challenge, do NOT retry it and never attempt to ' +
    'bypass or solve it — call done with a short report that the page is CAPTCHA-blocked, including ' +
    'anything you gathered before the challenge.';

  // Eager read-only ceiling (feedback c3c06260): 'disabled-by-config' is knowable
  // BEFORE the first step (CDP is never attempted). The caller passes
  // readOnlyCeiling=true ONLY when no local Mac fallback exists — otherwise the
  // note would suppress the very click/type refusal that triggers the
  // cloud→local re-route (b346ce80), stranding an online paired Mac.
  if (readOnlyCeiling) {
    prompt +=
      '\n\nIMPORTANT — this session is READ-ONLY from the start: click/type/scroll/screenshot WILL ' +
      'be refused (interactive cloud browsing is disabled on this server — CLOUD_BROWSER_CDP off — ' +
      'and no local Mac browser is available to take over). ' +
      'Plan read-only: navigate + get_content/extract, follow links by navigating. If the task ' +
      'fundamentally needs interaction, gather what you can read-only and call done with ' +
      'needs_interaction=true, stating plainly that interaction was unavailable and why. When reading ' +
      'was enough, just call done — never mention this limit for a task that did not need interaction.';
  }
  return prompt;
}

/**
 * Ticket ccd634fb: the answer itself says part of the task needed interaction it could not do
 * ("I could not click …", "it needs a login", "interaction was unavailable") — the hard banner
 * stays even when the model forgot done's needs_interaction flag. Pure; exported for tests.
 */
export const INTERACTION_LIMIT_TEXT_RE = /\b(?:could ?n[o'’]t|can ?n[o'’]t|cannot|unable to|not able to)\s+(?:click|type|scroll|log ?in|sign ?in|submit|fill|interact|press|select)\b|\binteraction (?:was |is )?(?:unavailable|not available)\b|\b(?:needs?|requires?) (?:a |an )?(?:log ?in|sign[- ]?in|interaction|clicks?)\b/i;
export function answerReportsInteractionLimit(text: string | null | undefined): boolean {
  return INTERACTION_LIMIT_TEXT_RE.test(String(text ?? ''));
}

/** Emit final answer as a few chunks so the UI shows it building, then return it. */
function streamFinal(text: string, sendEvent: (t: string, d: any) => void): void {
  const clean = (text || '').trim();
  if (!clean) return;
  // Split on sentence/paragraph boundaries into reasonable chunks.
  const pieces = clean.match(/[\s\S]{1,180}(\s|$)/g) || [clean];
  for (const p of pieces) sendEvent('chunk', { content: p });
}

/** Short, human-readable narration of an action for the live progress UI. */
function actionLabel(a: BrowserAction): string {
  if (a.reasoning) return a.reasoning;
  switch (a.name) {
    case 'navigate': return `Opening ${a.url || 'the page'}…`;
    case 'get_content': return 'Reading the page…';
    case 'extract': return 'Extracting details from the page…';
    case 'click': return `Clicking ${a.selector || a.ref || 'an element'}…`;
    case 'type': return `Typing into ${a.selector || a.ref || 'a field'}…`;
    case 'scroll': return 'Scrolling the page…';
    case 'screenshot': return 'Capturing the page…';
    default: return 'Working…';
  }
}

function toAction(name: string, args: any): BrowserAction {
  return {
    name: name as BrowserActionName,
    url: args?.url,
    format: args?.format,
    selector: args?.selector,
    ref: args?.ref,
    text: args?.text,
    submit: args?.submit,
    direction: args?.direction,
    amount: typeof args?.amount === 'number' ? args.amount : undefined,
    instruction: args?.instruction,
    message: args?.message,
    reasoning: args?.reasoning,
  };
}

/** Compact observation for feeding back to the model as a tool result. */
function observationForModel(obs: BrowserObservation): string {
  const parts: string[] = [`ok=${obs.ok}`];
  if (obs.url) parts.push(`url=${obs.url}`);
  if (obs.error) parts.push(`error=${obs.error}`);
  if (obs.truncated) parts.push('truncated=true');
  if (obs.links?.length) {
    parts.push('links:\n' + obs.links.slice(0, 30).map((l) => `- ${l.text} → ${l.href}`).join('\n'));
  }
  if (obs.screenshotBase64) parts.push('[screenshot captured]');
  if (obs.content) parts.push('content:\n' + obs.content);
  return parts.join('\n');
}

/**
 * A browser-agent answer is degenerate when it collapses into a repetitive
 * monologue (the model narrating "Let me…" over and over instead of reporting
 * findings — prod session 7be7440a). Heuristic: on non-trivial text, degenerate
 * if any sentence repeats ≥3× or the unique-sentence ratio drops below ~0.5.
 *
 * Ticket e6b16c4e: a text whose repetition carries NO sentence punctuation
 * (the incident: a Chinese slider-CAPTCHA interstitial page — 8k chars of
 *（拖拽）"drag here" filler around empty <div> shells — echoed by the model
 * verbatim into its final answer) previously sailed through: the splitter
 * produced ONE "sentence", and the `sentences.length < 4` early-pass returned
 * non-degenerate. Two hardening legs, both conservative:
 *   1. token-ratio: on long text, split on ALL whitespace and compare unique
 *      tokens to total. A varied report keeps a high ratio; a filler wall is
 *      almost entirely repeats, with or without punctuation.
 *   2. CJK character concentration: a filler wall concentrates its characters
 *      in a handful of glyphs (the incident wall: one glyph = 50% of all CJK
 *      chars); genuine Chinese prose never concentrates (的, the most common
 *      character, is only ~2.5–4.5% of ordinary text). Share, NOT count — an
 *      absolute count false-flags every long genuine answer (的×113 = share
 *      0.040 in a 2,847-char genuine report; reviewer repro, e6b16c4e round 2).
 */
export function isDegenerate(text: string): boolean {
  const t = (text || '').trim();
  if (t.length < 400) return false;
  const sentences = t.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 8);
  if (sentences.length >= 4) {
    const counts = new Map<string, number>();
    for (const s of sentences) counts.set(s, (counts.get(s) || 0) + 1);
    if ([...counts.values()].some(n => n >= 3)) return true;
    if (counts.size / sentences.length < 0.5) return true;
  }
  // e6b16c4e leg 1 — punctuation-free filler wall: unique-token ratio over the
  // whole text. Threshold 0.25: the incident wall scored ~0.0002 (essentially
  // one 4-char token repeated thousands of times); a genuine 400+ char report,
  // even terse or list-like, never drops that low.
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length >= 40) {
    const uniq = new Set(tokens).size;
    if (uniq / tokens.length < 0.25) return true;
  }
  // e6b16c4e leg 2 — CJK character concentration. A wall of the same CJK
  // chars（拖拽）thousands of times) concentrates half its characters in a
  // handful of glyphs; genuine Chinese prose — even repetitive-looking —
  // never concentrates (的, the most common character, sits at ~2.5–4.5% of
  // ordinary text). The threshold is a SHARE, not a count: an absolute count
  // false-flags every long genuine answer (reviewer repro: 的×113 = share
  // 0.040 in a 2,847-char genuine report — a >80-count ceiling would have
  // discarded it). Share > 0.30 with an ≥800-char CJK floor separates the
  // classes by ~7× margin and is magnitude-independent by construction.
  const cjk = (t.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).join('');
  if (cjk.length >= 800) {
    const c = new Map<string, number>();
    for (const ch of cjk) c.set(ch, (c.get(ch) || 0) + 1);
    if (Math.max(...c.values()) / cjk.length > 0.3) return true;
  }
  return false;
}

/**
 * CAPTCHA / human-verification challenge detector (ticket 58cad87c — a local-driver
 * session hit a CAPTCHA on swapcard, kept retrying, and the model degenerated into
 * a thousands-token mixed-language monologue instead of stopping cleanly).
 * Deterministic content sniff over the observation text: known widget markup
 * (reCAPTCHA / hCaptcha / Cloudflare Turnstile / Arkose / GeeTest — present when
 * the read used format="html") or explicit challenge phrasing aimed at the visitor
 * (present in format="text" snapshots of challenge interstitials). The bare word
 * "captcha" is deliberately NOT a signal on its own — an article ABOUT captchas
 * must not trip the guard; only imperative solve/complete phrasing counts.
 */
export function looksLikeCaptcha(text: string): boolean {
  const t = (text || '').slice(0, 50000).toLowerCase();
  if (!t) return false;
  const widgetMarkers = [
    // NOTE: deliberately EXCLUDES the reCAPTCHA v3 loader signals
    // (recaptcha/api.js, www.recaptcha.net, data-sitekey) — v3 is invisible,
    // non-blocking, and loaded site-wide on a large share of the web, so an
    // html read of a fully readable page would false-positive (review F1).
    'g-recaptcha', 'h-captcha', 'hcaptcha.com',
    'cf-turnstile', 'challenges.cloudflare.com', 'arkoselabs', 'funcaptcha',
    'geetest',
  ];
  if (widgetMarkers.some((m) => t.includes(m))) return true;
  const challengePhrases = [
    'verify you are human', 'verify that you are human', 'verify you are not a robot',
    'are you a robot', "i'm not a robot", 'i am not a robot',
    'prove you are human', 'confirm you are human', 'human verification',
    'checking if the site connection is secure', 'checking your browser before accessing',
    'complete the security check', 'security check to access',
    'please complete the captcha', 'complete the captcha', 'solve the captcha',
    'enter the captcha', 'captcha verification',
  ];
  return challengePhrases.some((p) => t.includes(p));
}

export async function runBrowserAgentSession(input: BrowserAgentInput): Promise<BrowserAgentResult> {
  const { userId, message, sendEvent } = input;
  const started = Date.now();

  sendEvent('progress', { message: 'Choosing the right browser for this task…', stage: 'query' });
  // 8fe9429c (reviewer F1): thread the worker's observe-only mode into the ROUTER
  // too — selectBrowserDriver uses it to describe the COMPUTER destination with the
  // observe-only variant (camera, no input), so a read-only worker is never
  // advertised an input-capable destination. The hard dispatch gate in
  // computer-loop.ts remains the enforcement layer; this is the prompt layer.
  const initial = await selectBrowserDriver(userId, message, {
    attach: input.attach === true,
    ...(input.device ? { device: input.device } : {}),
    ...(input.computerInputMode ? { computerInputMode: input.computerInputMode } : {}),
    // ea3ad8a8: the hosted hardened browser — the per-session context key.
    // Coding sessions scope per session; plain chats scope per chat. Absent
    // (legacy callers) → the router never offers the hosted destination.
    ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
  });
  sendEvent('progress', { message: initial.reason, stage: 'browser-route' });
  logger.info(`browser agent: driver=${initial.kind} user=${userId}`);

  // Self-host setup hardening (2026-10-20): the cloud reader is web search's
  // page fetch — on an instance with no search backend (never production) it
  // cannot load anything, so answer honestly now instead of spending a
  // planning call and a dead scrape to find that out.
  if (initial.kind === 'cloud' && webSearchMissingOnInstance()) {
    const note = 'browser_task cannot run on this Digby instance: no Mac is paired, the hosted browser service is off, and the cloud page reader needs web search, which is not set up here. An admin enables web search (or the browser service) under Account → Admin → Setup; a paired Mac is the other way to browse.';
    sendEvent('progress', { message: note, stage: 'browser-route' });
    return { finalResponse: note, elapsed: Date.now() - started, title: null, driverUsed: 'cloud', driverReason: initial.reason, localBrowserStatus: initial.localStatus, steps: 0 } as BrowserAgentResult;
  }

  // COMPUTER handoff (2026-09-09): the router judged that this task needs the
  // user's REAL desktop (their everyday browser's logins, an installed app,
  // their screen) — run the computer agent instead of a browser driver. Its
  // frames ride the same sendEvent (computer-observation → the panel's
  // driver:'computer' view); its final answer is streamed by the computer loop
  // itself, so no streamFinal here.
  if (initial.kind === 'computer') {
    const { runComputerAgentSession } = await import('../computer-agent/computer-loop');
    const r = await runComputerAgentSession({
      userId,
      chatId: input.chatId,
      message,
      sendEvent,
      // Multi-Mac: the explicit device target carries into the computer handoff.
      ...(input.device ? { device: input.device } : {}),
      // 8fe9429c: a read-only worker's browser_task runs the COMPUTER
      // destination camera-only — the incident's sub-agent reached the user's
      // real desktop (and quit Terminal) through exactly this handoff.
      ...(input.computerInputMode ? { inputMode: input.computerInputMode } : {}),
      // cu-diag fix #6: machine-run provenance + holder label for the
      // owner-presence gate and the use-lock holder record.
      ...(input.machineTriggered === true ? { machineTriggered: true } : {}),
      ...(input.holder ? { holder: input.holder } : {}),
      // A desktop task needs more steps than a bounded web read; keep the caller's
      // ceiling as a floor, not a cap.
      maxSteps: input.maxSteps ? Math.max(input.maxSteps, 10) : undefined,
      deadlineMs: input.deadlineMs ? Math.max(input.deadlineMs, 240000) : undefined,
    });
    return {
      finalResponse: r.finalResponse,
      elapsed: Date.now() - started,
      title: null,
      driverUsed: 'computer',
      driverReason: initial.reason,
      localBrowserStatus: initial.localStatus,
      capabilityNotice: r.capabilityNotice,
      steps: r.steps,
      ...(r.device ? { device: r.device } : {}),
      ...(r.observeOnly ? { computerObserveOnly: true } : {}),
      // Ticket a544f308: the handoff forwards the computer run's typed platform
      // so the CALLER's screenshot caption names the machine that was actually
      // driven. Dropping it here is what made a Windows capture render
      // "Final screen · Your Mac" — the parent defect (2d461d80) fixed one path
      // over and this handoff silently reintroduced it.
      ...(r.platform ? { computerPlatform: r.platform } : {}),
    };
  }

  let selection: BrowserDriverSelection = initial;
  let driver = selection.driver;

  // feedback c3c06260: when CDP is disabled by config we KNOW cloud interaction
  // is impossible before the first step — but pin the read-only ceiling into the
  // system prompt ONLY when no local Mac fallback exists (one cheap probe, the
  // same gate as the mid-loop escape hatch). With a fallback available the model
  // must stay free to attempt interaction so the refusal can trigger the
  // cloud→local re-route (b346ce80).
  let readOnlyCeiling = false;
  if (selection.kind === 'cloud' && driver.interactionCapability?.() === 'disabled-by-config') {
    readOnlyCeiling = (await selectLocalFallbackDriver(userId).catch(() => null)) === null;
  }

  const messages: GlmMessage[] = [
    { role: 'system', content: buildSystemPrompt(selection.kind, readOnlyCeiling, input.attach === true) },
    { role: 'user', content: message },
  ];

  let finalText = '';
  let steps = 0;
  // Ticket ccd634fb: did the session END on the model's own answer (done / a plain final turn), and
  // did that done flag a part of the task needing interaction? Read by the capability banner below.
  let answeredByModel = false;
  let doneNeedsInteraction = false;
  let fallbackUsed = false; // one cloud→local re-route per session (b346ce80)
  let degenerateTurns = 0; // consecutive degenerate turn-content strikes (58cad87c)
  let captchaStrikes = 0;  // consecutive CAPTCHA-detected observations (58cad87c)
  /** 4258335e: which local browser ACTUALLY drove (the agent stamps every
   *  observation) — the disclosure branches on this, never on the request. */
  let localMode: 'digby-profile' | 'attached' | undefined;

  // Tool-delegated sub-sessions (browser_task) run bounded so they fit inside
  // the calling agentic loop's per-tool budget; the full browser_agent mode
  // keeps the default cap.
  const maxSteps = Math.max(1, Math.min(input.maxSteps ?? MAX_STEPS, MAX_STEPS));
  const deadlineAt = input.deadlineMs ? started + input.deadlineMs : null;

  try {
    for (let step = 0; step < maxSteps; step++) {
      const onLastStep = step === maxSteps - 1 || (deadlineAt !== null && Date.now() >= deadlineAt);
      const turn = await glmChat({
        messages,
        // On the final allowed step, drop tools so the model must produce an answer.
        tools: onLastStep ? undefined : BROWSER_TOOL_SCHEMA,
        toolChoice: 'auto',
        reasoningEffort: 'high',
        maxTokens: 16384,
        temperature: 0.5,
        timeout: 150000,
      });

      const toolCalls = turn.tool_calls || [];

      // ticket 58cad87c — mid-loop degeneration guard. The final-answer
      // isDegenerate check (after the loop) fires only at the end; a model whose
      // turn content has ALREADY collapsed into a repetitive monologue burns up to
      // maxTokens every step, and feeding that garbage back as the assistant turn
      // compounds the collapse (the 7be7440a lesson below). Detect it per turn:
      // sanitize degenerate content out of history, and hand off to the wrap-up
      // after two consecutive degenerate turns (the first may still carry valid
      // tool calls worth executing).
      const turnText = stripThink(turn.content) || '';
      if (isDegenerate(turnText)) {
        degenerateTurns++;
        logger.warn(`browser agent: degenerate turn content (${turnText.length} chars, strike ${degenerateTurns}) — sanitizing history`);
      } else {
        degenerateTurns = 0;
      }

      // No tool calls → the model's content IS the final answer.
      if (!toolCalls.length) {
        // .trim(): whitespace-only content is as answer-less as empty content
        // (review N2) — route it to the wrap-up rather than returning a blank
        // finalResponse.
        const answer = stripThink(turn.content).trim();
        if (answer) {
          finalText = answer;
          answeredByModel = true;
          break;
        }
        // feedback fcc28eba: NEVER fall back to reasoning_content here. An
        // empty-content turn (a think-only payload, provider truncation, or a
        // null content on the forced no-tools final step) means the model had
        // no answer ready — its reasoning_content is the chain-of-thought
        // narrating the tool calls it WOULD run next ("get_tabs…, then
        // get_content snapshot on swapfile.com…"), which is exactly the
        // "trace head, no page data, no final report" payload the calling chat
        // agent received on local-driver runs. Break with finalText unchanged:
        // the wrap-up below re-asks over the accumulated observation history
        // (which holds the REAL page content from every executed step) and
        // writes the report from that.
        logger.warn('browser agent: empty-content turn with no tool calls — routing to wrap-up instead of surfacing reasoning_content');
        break;
      }

      // Record the assistant turn (with its tool_calls) before appending results.
      // Strip the <think> block: feeding GLM its own raw reasoning back each turn
      // was a driver of the degenerate 'Let me…' monologue (prod session 7be7440a).
      // Same rationale, one level up (58cad87c): a turn whose content is ALREADY
      // degenerate enters history as empty content — the tool_calls still execute,
      // but the garbage never rides the context to compound the next turn.
      messages.push({ role: 'assistant', content: degenerateTurns > 0 ? '' : turnText, tool_calls: toolCalls });

      let terminal = false;
      for (const tc of toolCalls) {
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* tolerate */ }
        const name = tc.function.name;
        steps++;

        if (name === 'done') {
          finalText = String(args?.message || '').trim() || finalText;
          answeredByModel = !!finalText;
          if (args?.needs_interaction === true || String(args?.needs_interaction).toLowerCase() === 'true') doneNeedsInteraction = true;
          terminal = true;
          messages.push({ role: 'tool', tool_call_id: tc.id, content: 'ok' });
          continue;
        }
        if (name === 'ask_user') {
          const q = String(args?.message || 'Could you clarify what you’d like me to do?').trim();
          sendEvent('ask_user', { message: q });
          // UI Phase 6b: the local Mac browser runs HEADLESS by default — the
          // model asking the user to intervene (login/2FA) implies they need to
          // SEE the page, so pop the window out on their Mac. Best-effort and
          // strictly additive: the driver resolves false on any failure (old
          // agent, env-forced headless, no live page) and the session ends with
          // the question either way. Ordered before driver.close() so the agent
          // processes pop_out first and leaves the popped-out window open.
          if (selection.kind === 'local' && typeof driver.popOutHeaded === 'function') {
            const popped = await driver.popOutHeaded().catch(() => false);
            if (popped) {
              sendEvent('progress', { message: 'Opened the browser window on your Mac so you can take over.', stage: 'browsing' });
            }
          }
          finalText = q;
          answeredByModel = false; // a question back is not a finished task
          terminal = true;
          messages.push({ role: 'tool', tool_call_id: tc.id, content: 'asked user' });
          continue;
        }

        const action = toAction(name, args);

        // Always surface a human-readable progress line (the existing UI renders
        // these), plus the richer transparency events for a future browser UI.
        sendEvent('progress', { message: actionLabel(action), stage: 'browsing' });
        if (STATE_CHANGING_ACTIONS.has(action.name)) {
          sendEvent('confirm', {
            action: action.name,
            selector: action.selector,
            text: action.text,
            reasoning: action.reasoning,
          });
        }

        const obs = await driver.execute(action);
        if (obs.mode) localMode = obs.mode; // 4258335e — the local agent stamps the ACTUAL browser mode

        // ticket 58cad87c — graceful CAPTCHA stop (the prod incident: a local-driver
        // session hit a CAPTCHA on swapcard, kept retrying, and degenerated into a
        // thousands-token mixed-language monologue). Deterministic sniff of the
        // observation; the model is told once (via its tool result below) to stop
        // and report — a second consecutive detection means it retried anyway, so
        // the loop force-stops into the wrap-up after this batch.
        const captchaHere = looksLikeCaptcha(`${obs.error || ''}\n${obs.content || ''}`);
        if (captchaHere) {
          captchaStrikes++;
          logger.warn(`browser agent: CAPTCHA / human-verification challenge detected at ${obs.url || action.url || 'current page'} (strike ${captchaStrikes})`);
          sendEvent('progress', { message: '⚠️ This page is showing a CAPTCHA / human-verification challenge — I cannot solve those.', stage: 'browsing' });
        } else if (obs.ok) {
          captchaStrikes = 0;
        }

        // feedback b346ce80: the cloud driver discovers a BrightData zone-block
        // only when a CDP call is refused — and in the default prod config
        // (CLOUD_BROWSER_CDP unset) every cloud session is read-only from the
        // start. Either way the session would grind on, unable to click or
        // type, with the user's paired Mac sitting online. Re-route ONCE, the
        // moment an INTERACTIVE action is refused (pure-read sessions keep
        // scraping on cloud — they work fine there); the turn's remaining
        // cloud-planned calls are abandoned and the model re-plans against the
        // local driver next step.
        if (
          !fallbackUsed
          && selection.kind === 'cloud'
          && driver.wasInteractiveRefused?.() === true
        ) {
          const local = await selectLocalFallbackDriver(userId, { attach: input.attach === true }).catch(() => null);
          if (local) {
            fallbackUsed = true;
            logger.warn('browser agent: cloud cannot interact (zone-blocked or CDP disabled) — falling back to the local Mac browser');
            sendEvent('progress', { message: local.reason, stage: 'browser-route' });
            await driver.close().catch(() => {});
            selection = local;
            driver = local.driver;
            messages.length = 0;
            messages.push(
              { role: 'system', content: buildSystemPrompt(selection.kind, false, input.attach === true) },
              { role: 'user', content: message },
            );
            break; // out of this turn's tool-call batch — re-plan on local
          }
        }

        sendEvent('browser-observation', {
          action: action.name,
          ok: obs.ok,
          url: obs.url,
          driver: selection.kind,
          preview: obs.error ? `⚠️ ${obs.error}` : (obs.content || '').slice(0, 280),
          reasoning: action.reasoning,
        });
        if (obs.screenshotBase64) {
          sendEvent('browser-observation', {
            action: 'screenshot', ok: true, url: obs.url, driver: selection.kind,
            screenshotBase64: obs.screenshotBase64, ...(obs.screenshotMime ? { mime: obs.screenshotMime } : {}),
          });
        } else if (input.liveView !== false && typeof driver.liveView === 'function') {
          // Live view (2026-09-09): the panel shows the page after EVERY action,
          // independent of the model's sparing use of its screenshot tool.
          // Best-effort — the driver resolves null when there is nothing new.
          const lv = await driver.liveView().catch(() => null);
          if (lv?.screenshotBase64) {
            sendEvent('browser-observation', {
              action: 'screenshot', ok: true, live: true, url: lv.url || obs.url || action.url,
              driver: selection.kind, screenshotBase64: lv.screenshotBase64, mime: lv.mime,
            });
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: observationForModel(obs) + (captchaHere
            ? '\n\nNOTE: a CAPTCHA / human-verification challenge is blocking this page. Do NOT retry it and never attempt to bypass or solve it. Call done now with a short report: that the page is CAPTCHA-blocked, plus anything you gathered before the challenge.'
            : ''),
        });
      }

      // Two consecutive degenerate turns → the model is not recovering: hand off
      // to the observation-history wrap-up instead of burning the remaining steps
      // (58cad87c). Same for a retried CAPTCHA: the wrap-up composes the report
      // from what was gathered, with the CAPTCHA NOTE above in history.
      if (degenerateTurns >= 2 || captchaStrikes >= 2) {
        if (degenerateTurns >= 2) {
          sendEvent('progress', { message: 'The browser model started repeating itself — wrapping up with what was gathered.', stage: 'browsing' });
        }
        break;
      }

      if (terminal) break;
    }

    // Ran out of steps without an explicit answer, OR the answer degenerated into
    // a repetitive monologue (prod session 7be7440a returned a 'Let me…' loop that
    // answered none of the requested checks) → force a clean task-focused wrap-up.
    if (!finalText || isDegenerate(finalText)) {
      answeredByModel = false; // the harness wrap-up, not the model's own done
      const wrap = await glmChat({
        messages: [
          ...messages,
          { role: 'user', content: `Answer the ORIGINAL task now: "${String(message || '').slice(0, 500)}". Give the concrete findings / pass-or-fail for each requested item based on what you saw. Do NOT narrate your next steps or repeat yourself.` },
        ],
        reasoningEffort: 'high',
        // 8192, not 4096: with reasoning_effort:"high" the model can spend a
        // small budget entirely on reasoning and return EMPTY content — the
        // fcc28eba empty-content hazard recurring inside the wrap-up itself.
        maxTokens: 8192,
        temperature: 0.2,
        timeout: 60000,
      });
      const wrapped = stripThink(wrap.content) || '';
      finalText = (wrapped && !isDegenerate(wrapped))
        ? wrapped
        // Triggered by an empty-content turn OR a degenerated answer — the
        // message must be honest for both (review N1).
        : 'The browser agent could not complete the task in the allotted steps — it returned no usable report. Try again, or narrow the task.';
    }
  } finally {
    driver.close().catch(() => {});
  }

  streamFinal(finalText, sendEvent);

  // feedback c3c06260: when the session ENDS on a cloud driver that cannot
  // interact (and no local fallback engaged — kind would be 'local' then), the
  // calling agent must get a hard, cause-naming capability signal at the
  // tool-result surface — not discover it from sub-agent narration several
  // steps in. Read-only findings still ride along; nothing is discarded.
  //
  // Ticket ccd634fb (nightly query suite 2026-10-06, 05-tools-browser): with CLOUD_BROWSER_CDP off
  // EVERY cloud session is read-only, so the banner fired on every pure page read too — "open
  // example.com and tell me the heading" came back headed "INTERACTION UNAVAILABLE (hard capability
  // limit)" over a correct answer, the calling model padded the reply with a read-only disclaimer
  // and the suite read the tool as FAILED. The banner now fires only when the limit BIT: an
  // interactive action was refused, the model flagged needs_interaction on done, its answer says it
  // could not click / log in / interact, or the session did not end on the model's own answer
  // (wrap-up / ask_user). Otherwise the result header carries a one-line readOnlyNote.
  // Kill switch BROWSER_READONLY_BANNER_ON_NEED_DISABLED=1 = the banner on every read-only session.
  let capabilityNotice: string | undefined;
  let readOnlyNote: string | undefined;
  if (selection.kind === 'cloud') {
    const cap = driver.interactionCapability?.();
    const limitBit = process.env.BROWSER_READONLY_BANNER_ON_NEED_DISABLED === '1'
      || driver.wasInteractiveRefused?.() === true
      || doneNeedsInteraction
      || !answeredByModel
      || answerReportsInteractionLimit(finalText);
    if (cap && cap !== 'cdp' && !limitBit) {
      readOnlyNote = 'read-only cloud browser (no click/type/scroll was attempted this session)';
    } else if (cap && cap !== 'cdp') {
      const causeSentence =
        cap === 'zone-blocked'
          ? "the BrightData zone rejected this server's egress IP (407 ip_forbidden) — it is not on the zone's IP allowlist"
          : cap === 'disabled-by-config'
            ? 'interactive cloud browsing is disabled on this server (CLOUD_BROWSER_CDP is off because the MCP gateway cannot hold a live browser session between calls)'
            : 'the live interactive browser session failed to start (transient gateway/upstream error)';
      capabilityNotice =
        'INTERACTION UNAVAILABLE — this browser session ran READ-ONLY. The cloud browser could not ' +
        `click, type, scroll, or screenshot: ${causeSentence}. ` +
        `Local Mac browser fallback: ${selection.localStatus || 'not checked'}. ` +
        'Read-only findings in the answer are valid, but any part of the task needing interaction ' +
        '(clicks, typing, scrolling, login) was NOT completed. To restore interaction: allowlist ' +
        "this server's egress IP in the BrightData Scraping Browser zone (the " +
        "get_platform_network_info tool reports the live IP), or pair/update the user's Mac app " +
        'to v0.2.0+.';
      sendEvent('progress', { message: capabilityNotice, stage: 'browser-capability' });
      logger.warn(`browser agent: ${capabilityNotice}`);
    }
  }

  return {
    finalResponse: finalText,
    elapsed: Date.now() - started,
    title: null,
    driverUsed: selection.kind,
    driverReason: selection.reason,
    // 4258335e: attachNote names WHY a requested CDP-attach will not run (agent
    // too old) — the caller can answer "why didn't my own Chrome engage?".
    // e6b16c4e: for a LOCAL run, re-read the device's presence NOW — a device
    // that died mid-task (the Windows-agent incident) must read 'offline …' in
    // the header, not the selection-time 'connected (Windows agent v0.9.0)'.
    localBrowserStatus: await (async () => {
      const note = driver.attachNote?.();
      const base = selection.kind === 'local' && selection.localAgentId
        ? await freshLocalBrowserStatus(selection.localAgentId, selection.localStatus || 'local browser')
        : selection.localStatus;
      return note ? `${base} · ${note}` : base;
    })(),
    capabilityNotice,
    ...(readOnlyNote ? { readOnlyNote } : {}),
    attachRequested: input.attach === true,
    localBrowserMode: localMode,
    steps,
  };
}
