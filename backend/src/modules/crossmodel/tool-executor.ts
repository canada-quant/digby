/**
 * Agentic Tool Executor — MCP Tool Proxy with Caching
 *
 * Gives Open Source models (GLM-5.2, Kimi K3, DeepSeek V4 Flash/Pro) autonomous tool-calling
 * abilities via OpenAI-compatible function calling. Each model decides independently
 * whether to use web search, URL scraping, or financial data tools.
 *
 * Architecture:
 *   1. Tool definitions are passed to models as OpenAI `tools` parameter
 *   2. When a model returns `tool_calls`, this executor handles them
 *   3. Results are cached per-request — if Model A already searched "TSLA stock price"
 *      and Model B makes the same call, the cached result is returned instantly
 *   4. Tool results are returned to the model as `tool` role messages
 *   5. Model then generates its final response using the real data
 *
 * Tools available (BrightData MCP — direct passthrough):
 *   - search_engine      → Google/Bing SERP results
 *   - scrape_as_markdown → Single URL → Markdown content
 *   - scrape_batch       → Multiple URLs (up to 5) → Markdown array
 *
 * Cache key: normalized(toolName + JSON.stringify(args))
 * Cache scope: per-request (ToolCache instance created per pipeline invocation)
 */

import { createHash } from 'crypto';
import logger from '../../utils/logger';
import prisma from '../../config/database';
// Web-search not-configured signal (ticket 6f4d42f2): the search tier records
// the credential-resolution outcome on this pure leaf; the agent-facing
// surfaces render the operator-actionable message when NOTHING is configured.
import { SEARCH_NOT_CONFIGURED_MSG, lastSearchConfigState } from './platform/search-config-state';
import { callMcpTool, webToolsDegraded } from './mcp-search';
import { webSearchStatus, webSearchProblemSuffix, WEB_SEARCH_UNCONFIGURED_MSG } from './platform/instance-setup';
// serp-provider-guard is a PURE leaf (zero imports) — safe to import here
// without touching the partial-factory mock contract on ./mcp-search.
import { type SerpProviderError } from './serp-provider-guard';
// WEB-2 route policy (goal 9ecd595e / WRP-1 D1·D2·D3): a PURE leaf — the
// paraphrase guard, the hard recency bound, the source-class ladder and the
// bounded backoff, all decision values a test can pin without a network.
import {
  planNextRouteForRun, recordAttempt, clusterFor, nextRouteClass, isTransientSearchFailure,
  exhaustedSearchMessage, ROUTE_LABEL, type RouteCluster,
} from './coding/web-search-route';
import { runWebPipe } from './coding/web-pipe';
// BS-1 D4/D5 (2026-11-02): the scrape tool's URL hygiene — the incomplete-URL
// pre-flight and the resolveDomainUrl retry ladder. PURE leaf + injected I/O.
import { preflightUrl, scrapeViaDomainResolve } from './coding/url-preflight';
import { runYoutubePipe } from './coding/youtube-pipe';
import { generateDocument, fillPdfForm, listPdfFormFields } from './document-generator';
import { loadAttachment } from './upload.controller';
// Type-only: the runtime call dynamic-imports './browser-agent' (no static cycle).
import type { BrowserAgentResult } from './browser-agent/types';
import type { ComputerAgentResult } from './computer-agent/types';
// Type-only: the runtime call dynamic-imports './image-generate' (leaf module —
// same no-static-cycle pattern as the browser agent).
import type { GeneratedImage, ImageAspect, GenerateImageInput } from './image-generate';
import { MAX_IMAGE_BYTES } from './coding/chat-images';
// Ticket c42e8099: the ONE tool-argument parser/refusal seam (leaf module — no
// imports, so no cycle) shared with the streaming path in coding/agent.ts.
import { parseToolArguments, toolArgumentRejection } from './coding/tool-arguments';
// Ticket c42e8099 ask (2): a refusal on THIS seam must be countable per chat.
// loop-metrics.service imports nothing that reaches this module (prisma, logger,
// run-telemetry-context, loop-metric-kinds, secret-scan), so no cycle.
import { recordLoopMetric } from './platform/loop-metrics.service';
import { LOOP_METRIC_KINDS } from './platform/loop-metric-kinds';

// Told to the model when a web tool returns nothing BECAUSE the gateway/circuit is
// degraded (transient infra) — so it doesn't conclude the topic has no results.
const WEB_DEGRADED_MSG = 'Web search is temporarily unavailable (the search gateway is recovering) — this is a transient infrastructure issue, NOT an indication that no results exist. Do not give up on the topic: use other tools (e.g. GitHub/connector tools) or your own knowledge, note that live web results were unavailable, and you may retry web search shortly.';

/**
 * The honest text for a web tool that answered null (2026-10-20, self-host
 * setup hardening): an instance with NO search backend first — a self-host
 * without BRIGHTDATA_API_TOKEN / an MCP gateway used to hear "No search results
 * found. Try a different query." (the model read a missing configuration as an
 * empty topic, retried, then answered from memory with search calls in the
 * transcript) — then the transient-degradation wording, else the legacy line.
 * Production never reaches the first branch (every prod process has a token).
 */
function webNullResultMsg(legacy: string): string {
  // The tier's own last resolution (env key, admin-store key, an ON gateway —
  // ticket 6f4d42f2) outranks the env-only leaf: a backend it resolved is never
  // "not configured"; the null is then the legacy degraded / empty case.
  if (lastSearchConfigState()?.anyBackendArmed !== true && !webSearchStatus().configured) return WEB_SEARCH_UNCONFIGURED_MSG + webSearchProblemSuffix();
  return webToolsDegraded() ? WEB_DEGRADED_MSG : legacy;
}

// Returned by every document tool when the request is anonymous — generated
// files are owned per-user, so there is nothing to act on without an account.
const DOC_SIGN_IN_MSG = 'Document tools need a signed-in account. Ask the user to sign in, then try again.';

// Document tool names — they read/write LIVE per-user DB state, so the
// request-scoped cache must never serve them stale (a list_files cached before
// a same-run create_document would return the pre-create list), and their
// validation errors are usually model-fixable (bad sheets shape, invalid JSON)
// — the catch-all must not tell the model to abandon the user's document.
// generate_image (2026-09-24) rides the same set: it writes a GeneratedFile row
// and consumes rate slots — a cached replay would silently skip both.
const DOC_TOOL_NAMES = new Set(['create_document', 'read_document', 'update_document', 'list_files', 'fill_pdf_form', 'generate_image']);

/** Relative download path — chat markdown renders it as a same-origin link
 *  (the query-token route authenticates via the cm_access cookie). */
const downloadPath = (fileId: string) => `/api/crossmodel/generated-files/${fileId}/download`;

/** Relative INLINE byte path for a generated IMAGE (generate_image, 2026-09-24):
 *  the persisted transcript part carries this url instead of base64; the
 *  image-only inline route (Bearer + cookie/query-token twin) serves the bytes. */
export const inlineGeneratedPath = (fileId: string) => `/api/crossmodel/generated-files/${fileId}/inline`;

/** Validate + sanitize the `sheets` tool arg into the generator's shape. */
function normalizeSheets(raw: any): { name: string; rows: (string | number | boolean | null)[][] }[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error('`sheets` must be an array of { "name": string, "rows": [[cell, …], …] } objects.');
  }
  return raw.map((s: any, i: number) => {
    if (!s || typeof s !== 'object' || !Array.isArray(s.rows)) {
      throw new Error(`sheets[${i}] must be an object with a rows array — e.g. { "name": "Sales", "rows": [["Month","Total"],["Jan",1200]] }.`);
    }
    const rows = s.rows.map((r: any, j: number) => {
      if (!Array.isArray(r)) throw new Error(`sheets[${i}].rows[${j}] must be an array of cell values (string | number | boolean | null).`);
      return r.map((c: any): string | number | boolean | null => {
        if (c === null || c === undefined) return null;
        if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') return c;
        return String(c);
      });
    });
    return { name: typeof s.name === 'string' && s.name.trim() ? s.name.trim() : `Sheet${i + 1}`, rows };
  });
}

/** ISO date (YYYY-MM-DD) for list output; tolerant of mocked string dates in tests. */
function fmtDate(d: any): string {
  const dt = d instanceof Date ? d : new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toISOString().slice(0, 10);
}

/**
 * browser_task tool-result formatter (feedback c3c06260).
 *
 * Driver transparency (feedback 2027d98d): the calling model — and the user it
 * relays to — must be able to tell WHICH browser ran and why the paired-Mac
 * local browser did or didn't engage. The GLM-authored reason is untrusted-ish
 * text: cap it and strip header-breaking chars (review nit — keeps the one-line
 * header intact).
 *
 * When the sub-session ran READ-ONLY at a hard capability limit (cloud driver
 * could not click/type/scroll/screenshot and no local fallback engaged), the
 * browser-agent result carries a capabilityNotice — PREPEND it as a hard banner
 * so it is the FIRST thing the calling model reads, instead of buried in
 * sub-agent narration several steps in. Read-only findings still ride along
 * below the banner; nothing is discarded.
 */
export function formatBrowserTaskToolResult(result: BrowserAgentResult): string {
  const text = (result.finalResponse || '').trim();
  const clean = (s?: string) => (s || '').replace(/[\r\n[\]]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 200);
  const localLine = result.localBrowserStatus ? ` · local browser: ${clean(result.localBrowserStatus)}` : '';
  const whyLine = result.driverReason ? ` · why: ${clean(result.driverReason)}` : '';
  const deviceLine = (result as any).device && (result as any).device !== 'Mac' ? ` · device: ${clean((result as any).device)}` : '';
  // Ticket ccd634fb: a read-only cloud session whose limit never bit carries a one-line header fact,
  // not the hard banner (which read as a failed tool over a correct page read).
  const readOnlyLine = result.readOnlyNote && !result.capabilityNotice ? ` · mode: ${clean(result.readOnlyNote)}` : '';
  const banner = result.capabilityNotice
    ? `[BROWSER_TASK — INTERACTION UNAVAILABLE (hard capability limit)]\n${result.capabilityNotice}\n`
    : '';
  // Feedback 88915954 (ask a): a local run's header must state plainly WHAT the
  // local browser is — a separate Digby-managed profile, NOT the user's everyday
  // Chrome — so the calling model can never again "confirm the real (non-headless)
  // browser" while eliding the separation. The tool description binds the model
  // to relay this line.
  // Feedback 4258335e: the disclosure branches on the mode that ACTUALLY ran —
  // CDP-attach mode (a dedicated new tab of the user's everyday Chrome) must be
  // named as their real profile; the separate-profile wording applies only to
  // the Digby profile, with an attach-fallback note when attach was requested.
  const localDisclosure = result.driverUsed === 'local'
    ? result.localBrowserMode === 'attached'
      ? '\n[LOCAL BROWSER — CDP ATTACH — DISCLOSE PLAINLY IN YOUR ANSWER: this ran in a NEW TAB of the user\'s EVERYDAY Chrome on their computer — their real signed-in profile (explicit opt-in CDP attach). Never call it a separate Digby profile. Hard rails were enforced: no typing into password/credential fields, no form submits.]'
      : `\n[LOCAL BROWSER — DISCLOSE PLAINLY IN YOUR ANSWER: this is a SEPARATE Digby browser profile on the user's computer, NOT their everyday Chrome/Safari/Edge. Never call it just "your real browser" or "not headless".]${result.attachRequested ? '\n[CDP attach was requested for this task but did NOT engage (agent older than v0.5.0, owner switch off, or no Chrome on the debugging port) — Digby\'s separate profile ran instead; say so if the user asked for their own Chrome.]' : ''}`
    : '';
  // 8fe9429c: an observe-only COMPUTER handoff is disclosed as a hard
  // capability limit — the calling (read-only) worker must report that the
  // desktop was only LOOKED at, never acted on, and route any required action
  // back to the orchestrator.
  const observeDisclosure = result.driverUsed === 'computer' && result.computerObserveOnly
    ? '\n[COMPUTER DESTINATION — OBSERVE-ONLY: this session ran CAMERA-ONLY on the user\'s desktop (you are a read-only worker). Screenshots were taken; NO clicks, keystrokes, scrolling, app opens or quits were possible — every input action is refused at the harness gate. Report observations only; if the task required acting on the desktop, say so and let the orchestrator perform it with full computer use.]'
    : '';
  return `${banner}[Browser agent result — driver: ${result.driverUsed}, steps: ${result.steps}${localLine}${whyLine}${deviceLine}${readOnlyLine}]${localDisclosure}${observeDisclosure}\n${text}`;
}

/**
 * Browser-program forwarding (UI Phase 6a): the browser_task sub-session emits
 * per-action `browser-observation` transparency events (glm-loop.ts — action,
 * ok, url, driver, preview/reasoning, plus a separate screenshot event with
 * screenshotBase64). The tool path used to discard them (`sendEvent: () => {}`);
 * now they forward up the CALLING lane's event stream as the coding-vocabulary
 * `browser_observation` so the chat/coding browser panel can render a live view.
 *
 * Pure filter — only `browser-observation` passes. The sub-session's own
 * progress/chunk/confirm events stay private (the calling model narrates for
 * the user, and its final answer must never double-stream). An oversized
 * screenshot payload is dropped from the frame (never the observation itself)
 * so a forwarded event can't bloat the Redis run-event mirror or the durable
 * agent_events log.
 */
export const MAX_FORWARDED_SCREENSHOT_CHARS = 1_500_000; // ~1.1 MB decoded PNG
export function forwardableBrowserObservation(
  type: string,
  data: any,
): { type: 'browser_observation'; data: any } | null {
  if (!data || typeof data !== 'object') return null;
  // Computer use (2026-09-09): computer_task's frames (computer-agent/
  // computer-loop.ts `computer-observation`) render in the SAME panel as a
  // browse, tagged driver:'computer' (JPEG screenshots) — the user's Mac screen
  // shows live as the agent works.
  const isBrowser = type === 'browser-observation';
  const isComputer = type === 'computer-observation';
  if (!isBrowser && !isComputer) return null;
  const frame = isComputer ? { ...data, driver: 'computer', mime: data.mime || 'image/jpeg' } : data;
  if (typeof frame.screenshotBase64 === 'string' && frame.screenshotBase64.length > MAX_FORWARDED_SCREENSHOT_CHARS) {
    const { screenshotBase64: _dropped, ...rest } = frame;
    return { type: 'browser_observation', data: rest };
  }
  return { type: 'browser_observation', data: frame };
}

/**
 * Screenshots IN THE CHAT (owner 2026-09-23: "are you sure it knows how to
 * embed images in chat… I haven't seen any images"). Until now every
 * browser_task / computer_task screenshot went ONLY to the side panel's Browser
 * tab — nothing ever wrote an image into the assistant transcript, and the
 * model has no tool to attach one, so the chat itself never showed a picture.
 *
 * Now the executor keeps the LAST screenshot frame each sub-session emitted and
 * hands it to the agent loop as an attached image once the tool returns; the
 * loop appends it to the assistant message as an `image` part right after the
 * tool card (persisted with the run — the coding GET lazily serves the bytes by
 * URL) and emits an `image` event so the live view shows it immediately.
 */
export interface AttachedImage {
  mediaType: string;
  data: string;
  /** Caption — renders under the thumbnail. */
  name: string;
  source: 'browser' | 'computer' | 'generated' | 'fetched';
  /**
   * 'generated' (generate_image, 2026-09-24): the bytes already live in a
   * GeneratedFile row — the agent loop persists a url-only part (fileId →
   * inlineGeneratedPath) and streams the base64 only on the live event.
   * 'fetched' (fetch_image, e8ef6b04): the bytes ride the AttachedImage as
   * base64, exactly like screenshots.
   */
  /** Page URL at capture (browser) / source URL of the fetch (fetched) — NOT `url`, which the transcript reserves for the lazy image URL. */
  pageUrl?: string;
  /** Frontmost app at capture (computer). */
  app?: string;
  /** GeneratedFile id (generated only). */
  fileId?: string;
  /** The prompt the image was generated from (generated only). */
  prompt?: string;
}

/** Human caption for an attached screenshot ("Final screen · Your Mac · Google Chrome"). */
export function screenshotCaption(source: 'browser' | 'computer', ctx: { pageUrl?: string; app?: string }): string {
  if (source === 'computer') return `Final screen · Your Mac${ctx.app ? ` · ${ctx.app}` : ''}`;
  let host = '';
  try { host = ctx.pageUrl ? new URL(ctx.pageUrl).hostname.replace(/^www\./, '') : ''; } catch { host = ''; }
  return host ? `Final page · ${host}` : 'Final page';
}

/** Pick the screenshot payload off a forwarded browser_observation frame, or null. */
export function screenshotFromFrame(data: any): { data: string; mediaType: string } | null {
  if (!data || typeof data !== 'object' || typeof data.screenshotBase64 !== 'string' || !data.screenshotBase64) return null;
  const mime = typeof data.mime === 'string' && /^image\//.test(data.mime) ? data.mime : 'image/png';
  return { data: data.screenshotBase64, mediaType: mime };
}

/**
 * e8ef6b04: sniff an image's mediaType from magic bytes — png / jpeg / webp /
 * gif. Returns null when the bytes are none of those (never trust a declared
 * content-type; an HTML error page must not become an image part).
 */
export function sniffImageMedia(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF' && (bytes.toString('ascii', 3, 6) === '87a' || bytes.toString('ascii', 3, 6) === '89a')) return 'image/gif';
  return null;
}

/**
 * computer_task tool-result formatter — the formatBrowserTaskToolResult pattern:
 * the paired-Mac availability line always rides the header so the calling model
 * can answer "why didn't computer use engage?", and a capabilityNotice (no
 * usable Mac / vision unconfigured / first screenshot failed) PREPENDS as a hard
 * banner that is the FIRST thing read.
 *
 * Epistemic label (Framework Operator firing 3, 2026-09-22 — the canlegal F94
 * fabricated-success class): the sub-agent's finalResponse is MODEL NARRATION,
 * not ground truth. Live case: two computer_task re-gathers returned
 * "verified 3138-byte scp+ssh transfer … 216.1KB/s" reports that echoed the
 * GENUINE prior attempt's byte count and transfer rate verbatim, while box-side
 * SSM reads proved no transfer occurred and the on-Mac state file disagreed.
 * A calling lane that treats the envelope as verified ground truth can bank a
 * false external action. The deterministic label below is stamped by the
 * HARNESS between the header and the narration — before the model reads a
 * word of it — and says exactly what a caller must do: treat claims of
 * external state as narration and verify against an independent channel
 * before relying on them.
 */
const COMPUTER_TASK_UNVERIFIED_LABEL = [
  '[SUB-AGENT NARRATION — UNVERIFIED]',
  'The report below is the computer-use sub-agent\'s own account of what it did and saw, NOT a harness-verified observation.',
  'Success/error claims about files, transfers, app state or any EXTERNAL system may be fabricated (observed live 2026-09-22: a "verified 3138-byte scp transfer" echoed a prior real transfer\'s numbers with no transfer present).',
  'Before relying on ANY claimed external effect, verify it yourself through an independent channel (box read, SSM, git, the platform\'s own tools) and cite THAT receipt — never this text.',
].join(' ');

export function formatComputerTaskToolResult(result: ComputerAgentResult): string {
  const text = (result.finalResponse || '').trim();
  const clean = (s?: string) => (s || '').replace(/[\r\n[\]]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 200);
  const macLine = result.localStatus ? ` · mac: ${clean(result.localStatus)}` : '';
  // Ticket d427c381 (2026-10-27): the device line goes LOUD whenever the task
  // text named a device — auto-bound (param omitted) or a mismatch with the
  // explicit param — so a caller can never mistake another Mac's healthy
  // capture for the named machine's result (the mishap: a lane nearly cleared
  // a capture-dead diagnosis off a healthy capture of the wrong Mac).
  const taskNamed = result.taskTextNamedDevices || [];
  const otherNamed = result.taskTextNamesOtherThanParam || [];
  let deviceLine = result.device && result.device !== 'Mac' ? ` · device: ${clean(result.device)}` : '';
  // Reviewer F1 (PR #2020): the loud flags must render even when the driven
  // device's display name is bare 'Mac' (deviceLine empty) — nesting them
  // inside `if (deviceLine)` silently dropped the MISMATCH/AUTO-BOUND text on
  // exactly the header shapes that most need it.
  if (result.deviceAutoBound) {
    deviceLine += ` · DEVICE AUTO-BOUND FROM THE TASK TEXT (it named '${taskNamed.join("', '")}' and the device parameter was omitted) — confirm this is the machine the caller meant`;
  } else if (otherNamed.length > 0) {
    deviceLine += ` · DEVICE MISMATCH — the task text named '${otherNamed.join("', '")}' but device: '${clean(result.device)}' was driven (the explicit device parameter wins)`;
  }
  // cu-diag 2026-09-25 fix #6: a lock refusal is a STRUCTURED non-error —
  // its own BUSY banner naming the holder (chat id + lane), never the
  // UNAVAILABLE banner (the device is fine; someone else is driving it).
  const banner = result.busy
    ? `[COMPUTER_TASK — BUSY]\n${result.capabilityNotice || 'Another computer-use session is driving this device.'}\n` +
      `holder: ${result.busy.holderLane || 'unknown lane'}${result.busy.holderChatId ? ` · chat ${result.busy.holderChatId}` : ''}${result.busy.since ? ` · since ${result.busy.since}` : ''} · waited ${Math.round(result.busy.waitedMs / 1000)} s\n`
    : result.capabilityNotice
      ? `[COMPUTER_TASK — UNAVAILABLE]\n${result.capabilityNotice}\n`
      : '';
  // 8fe9429c: an observe-only session is disclosed as a hard capability limit —
  // the calling (read-only) worker must report that the desktop was only LOOKED
  // at, never acted on, and route any required action back to the orchestrator.
  const observeLine = result.observeOnly
    ? (result.ownerPresence?.gated
        ? ` · OBSERVE-ONLY (owner active: ${clean(result.ownerPresence.reason)} — machine run was camera-only)`
        : ' · OBSERVE-ONLY (camera; no input was possible)')
    : result.ownerPresence?.active
      ? ` · owner active (${clean(result.ownerPresence.reason)})`
      : '';
  // cu-diag fix #3 (2026-09-25): harness-measured counters ride the header so
  // lanes and supervisors reason from harness FACTS (what the loop itself
  // refused, scored, graded and probed), never from the sub-agent's narration
  // — the incident's supervisor told the owner keystrokes were dead on the
  // strength of a sub-agent's "(C) INPUT DEAD" verdict that its own frontmost
  // field falsified. Absent when the session never started (steps 0 paths).
  const h = result.harness;
  const harnessLine = h
    ? ` · harness: refusedRepeats=${h.refusedRepeats} noChangeStrikes=${h.noChangeStrikes} degenerateFrames=${h.degenerateFrames}` +
      ` frame=${h.frameGeometry || 'none'} displays=${h.displayCount === null || h.displayCount === undefined ? 'unknown' : h.displayCount}` +
      (h.probesRun ? ` probe=${h.probesPassed}/${h.probesRun}${h.inputProven ? ' input-proven' : ' FAILED'}` : '') +
      (h.frontmostChanges ? ` frontmostChanges=${h.frontmostChanges}` : '')
    : '';
  // c468f922 (2026-10-28): the typed PRE-LOGIN INPUT capability rides every
  // result header — `prelogin_input: unavailable` is the fact that lets a lane
  // fail fast instead of retry-looping a device that structurally cannot accept
  // input while locked. Omitted from the header when the refusal banner already
  // carries it (no doubled line).
  const preloginLine = result.prelogin && !result.capabilityNotice
    ? ` · prelogin_input: ${result.prelogin.status}` +
      (result.prelogin.blockedNow ? ' · BLOCKED NOW (lock/login screen)' : '')
    : '';
  const label = `${COMPUTER_TASK_UNVERIFIED_LABEL}\n`;
  return `${banner}[Computer task result — steps: ${result.steps}${macLine}${deviceLine}${observeLine}${harnessLine}${preloginLine}]\n${label}${text}`;
}

// ── Per-user storage quota (adversarial review M1) ──────────────────────────────
// A tool loop can mint GeneratedFile rows at machine speed; without a ceiling one
// account (or a runaway agent) grows the table unboundedly. Caps: 100 rows AND
// ~200MB of STORED payload per user. The payload column is base64, so the stored
// footprint is estimated from the raw `size` column at 4/3 (base64 overhead) —
// an estimate is deliberate: the cap is a guardrail, not accounting.
const MAX_GENERATED_FILES_PER_USER = 100;
const MAX_GENERATED_PAYLOAD_BYTES_PER_USER = 200 * 1024 * 1024;

/** Stored base64 length for a raw byte count (4 chars per 3 bytes, padded). */
const base64Bytes = (rawBytes: number) => Math.ceil(rawBytes / 3) * 4;

/**
 * Returns a model-facing error string when storing `incomingRawBytes` for
 * `userId` would breach the per-user quota, else null.
 *
 * `newRow: false` is the update_document case — it replaces a row in place, so
 * only the byte cap applies, net of the bytes being replaced (`replacesRawBytes`).
 *
 * There is NO agent-facing delete tool — the only delete surface is the REST
 * endpoint DELETE /api/crossmodel/generated-files/:id behind the Files page —
 * so the error text tells the model to send the user there.
 */
async function generatedFileQuotaError(
  userId: string,
  incomingRawBytes: number,
  opts: { newRow: boolean; replacesRawBytes?: number; surface?: 'document' | 'image' }
): Promise<string | null> {
  const agg = await prisma.generatedFile.aggregate({
    where: { userId },
    _count: { _all: true },
    _sum: { size: true },
  });
  const count = agg._count._all ?? 0;
  const existingRaw = agg._sum.size ?? 0;
  // A generated IMAGE cannot be shrunk by the model and the model cannot free
  // space, so its message says "do not retry" — a retry is another paid call.
  const image = opts.surface === 'image';
  if (opts.newRow && count >= MAX_GENERATED_FILES_PER_USER) {
    return image
      ? `Storage quota reached: this account already has ${count} generated files (limit ${MAX_GENERATED_FILES_PER_USER}). There is no delete tool — tell the user to delete old files from their Files page (/files). Do not retry generate_image this run; only the user can free space.`
      : `Storage quota reached: this account already has ${count} generated files (limit ${MAX_GENERATED_FILES_PER_USER}). There is no delete tool — tell the user to delete old files from their Files page (/files) and then retry.`;
  }
  const projectedRaw = existingRaw - (opts.replacesRawBytes ?? 0) + incomingRawBytes;
  if (base64Bytes(projectedRaw) > MAX_GENERATED_PAYLOAD_BYTES_PER_USER) {
    const usedMb = (base64Bytes(existingRaw) / 1024 / 1024).toFixed(1);
    return image
      ? `Storage quota reached: this account's generated files already use ~${usedMb}MB of the 200MB storage cap and an image would exceed it. There is no delete tool — tell the user to delete old files from their Files page (/files). Do not retry generate_image this run; only the user can free space.`
      : `Storage quota reached: this account's generated files already use ~${usedMb}MB of the 200MB storage cap and this file would exceed it. Reduce the file's size, or tell the user to delete old files from their Files page (/files) — there is no delete tool.`;
  }
  return null;
}

// ── Image generation (generate_image tool + POST /images/generate) ───────────
// Owner ask 2026-09-24: "add image generation model and admin endpoint and
// defaults to generate images". The model call itself lives in the leaf
// ./image-generate (the admin-editable Image generator seat); everything below
// is the shared plumbing both surfaces use — validation, reference resolution,
// rate slots, persistence as a GeneratedFile, telemetry — so the tool and the
// REST mirror can never drift apart.

/** Thrown by storeGeneratedImage when the per-user GeneratedFile quota refuses
 *  the row — the tool returns .message verbatim, the REST mirror maps it to 413. */
export class GeneratedFileQuotaError extends Error {
  readonly code = 'quota' as const;
  constructor(message: string) {
    super(message);
    this.name = 'GeneratedFileQuotaError';
  }
}

/**
 * Ticket e4d345a9 — the generated-file OWNER cannot be resolved.
 *
 * `generated_files.userId` is `NOT NULL` with an FK to `users(id)`
 * (`generated_files_userId_fkey`), so persisting a row for an id that has no
 * `users` row throws a Prisma P2003 whose message the tool layer used to hand
 * straight back to the model: "Invalid `prisma.generatedFile.create()`
 * invocation … Foreign key constraint violated". The model could not act on
 * that text, retried, and the run derailed (guard_strike seam
 * `tool_derail_break`, 8 rows in 15 h).
 *
 * This is the TYPED containment: an unresolvable owner is a known, bounded
 * condition — one honest sentence the agent relays and does not retry — not an
 * opaque ORM failure. Thrown by createGeneratedFileRow and returned verbatim by
 * the document tools; the REST mirror maps it to 503.
 */
export const GENERATED_FILE_OWNER_MSG =
  'File storage is unavailable for this session: its account could not be resolved, so nothing can be saved. Tell the user the file was NOT created and that signing in (or signing in again) fixes it. Do not retry this tool this run.';

export class GeneratedFileOwnerError extends Error {
  readonly code = 'owner_unresolved' as const;
  constructor(message: string = GENERATED_FILE_OWNER_MSG) {
    super(message);
    this.name = 'GeneratedFileOwnerError';
  }
}

/**
 * The anonymous sentinels a run may carry where a userId is REQUIRED by
 * non-FK stores. `chat-agent.service.ts` sets `runUserId = userId || 'anonymous'`
 * for guest turns (and binds guest sessions to `anon-<sid>`); neither value is
 * a `users` row — the key-value stores the sentinel was designed for have no
 * FK, but `generated_files` does.
 *
 * Normalizing the sentinel to null is what makes the document tools' long-
 * standing `if (!this.userId) return DOC_SIGN_IN_MSG` guard actually fire for a
 * guest: before this, 'anonymous' was TRUTHY, so the guard passed and every
 * guest generate_image / create_document attempt reached the FK and failed
 * (ticket e4d345a9; the telemetry rows are `anon-…` chats).
 */
function normalizeToolUserId(userId: string | null | undefined): string | null {
  const id = typeof userId === 'string' ? userId.trim() : '';
  if (!id || id === 'anonymous' || id.startsWith('anon-')) return null;
  return id;
}

/** True when `err` is Prisma's P2003 (FK violation) raised by a generated-file
 *  INSERT. `generated_files` has exactly one FK (`userId` — `chatId` is a bare
 *  column by design), so any P2003 from this create IS the owner FK, whether or
 *  not the driver filled in `meta.constraint`. */
function isGeneratedFileOwnerFkViolation(err: any): boolean {
  return err?.code === 'P2003' || /generated_files_userId_fkey/.test(String(err?.message ?? ''));
}

/**
 * INSERT one generated_files row, guaranteeing that an unresolvable owner can
 * never escape as a raw Prisma error (ticket e4d345a9 asks (1) and (2)):
 *   - resolve the id against `users` FIRST, so the common stale/deleted-account
 *     case never reaches the constraint at all;
 *   - translate the residual FK failure (an owner deleted between the check and
 *     the insert) into the same typed error.
 * Both paths log ONE warn-line under their own signature — never the opaque
 * `Invalid prisma.generatedFile.create()` error text, which is what made this
 * class invisible as anything but "the tool broke", and never at level=error
 * (a resolvable-by-the-user condition is not a platform fault).
 *
 * The `users` probe is read through a guarded accessor because the tool-layer
 * suites fake `config/database` with a partial factory that does not model
 * `users`; production always has it. The FK catch below holds either way.
 */
async function createGeneratedFileRow(
  data: Record<string, any>,
  surface: 'document' | 'image' = 'document',
): Promise<{ id: string }> {
  const ownerId = String(data?.userId ?? '');
  const userModel = (prisma as any)?.user;
  if (typeof userModel?.findUnique === 'function') {
    const owner = await userModel.findUnique({ where: { id: ownerId }, select: { id: true } }).catch(() => undefined);
    if (owner === null) {
      logger.warn(`Generated file NOT saved (${surface}) — owner id has no users row (generated_file_owner_unresolved) user=${ownerId}`);
      throw new GeneratedFileOwnerError();
    }
  }
  try {
    return await prisma.generatedFile.create({ data: data as any });
  } catch (err: any) {
    if (isGeneratedFileOwnerFkViolation(err)) {
      logger.warn(`Generated file NOT saved (${surface}) — owner id has no users row (generated_file_owner_unresolved, fk) user=${ownerId}`);
      throw new GeneratedFileOwnerError();
    }
    throw err;
  }
}

const IMAGE_ASPECTS: ReadonlySet<string> = new Set(['square', 'landscape', 'portrait', 'wide', 'tall']);
const IMAGE_PROMPT_MIN = 3;
const IMAGE_PROMPT_MAX = 2000;
const IMAGE_STYLE_MAX = 200;
const IMAGE_NEGATIVE_MAX = 500;

/** Env-tunable spend caps (read per call so an env change needs no restart). */
export const imageChatHourlyCap = () => Number(process.env.IMAGE_CHAT_HOURLY_CAP) || 8;
export const imageUserDailyCap = () => Number(process.env.IMAGE_USER_DAILY_CAP) || 40;

/**
 * Bytes a generated image is ASSUMED to weigh before it exists — the quota
 * pre-flight's estimate (a 1024² PNG measured 519–756 KB live; 2K edits
 * ~2.4 MB). The post-call check in storeGeneratedImage is byte-accurate.
 */
export const IMAGE_QUOTA_ESTIMATE_BYTES = 1536 * 1024;

/**
 * Quota pre-flight (review 2026-09-24): run BEFORE the rate slots and the
 * paid provider call, so a full account never pays $0.01–0.035 and waits up
 * to 240 s for an image that is then discarded. Returns the model/REST-facing
 * refusal (413 on the REST mirror) or null. One cheap prisma aggregate.
 */
export async function preflightImageQuota(userId: string): Promise<string | null> {
  return generatedFileQuotaError(userId, IMAGE_QUOTA_ESTIMATE_BYTES, { newRow: true, surface: 'image' });
}

/** Format column + extension for the sniffed mime of a generated image. */
const IMAGE_FORMAT_BY_MIME: Record<string, 'png' | 'jpg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Magic-byte sniff for the three raster types the providers return. Trusted
 * OVER any declared mime/extension: Z.AI serves JPEG bytes labelled image/png
 * (live probe 2026-09-24), and a wrong format column would mislabel the Files
 * page + the inline route's Content-Type.
 */
export function sniffGeneratedImageMime(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Strip provider credentials from a message before it reaches a model, a
 * client or a log line (axios errors can echo request config). Never
 * stringify err.config anywhere on this path.
 */
export function scrubImageSecrets(text: string): string {
  let out = String(text ?? '');
  for (const key of [process.env.DASHSCOPE_API_KEY, process.env.ZAI_API_KEY]) {
    if (key && key.length >= 8) out = out.split(key).join('[redacted]');
  }
  return out.replace(/Bearer\s+[A-Za-z0-9._\-]{8,}/g, 'Bearer [redacted]');
}

export type GenerateImageArgs = Pick<GenerateImageInput, 'prompt' | 'aspect' | 'style' | 'polish' | 'negativePrompt'>;

/**
 * Validate the model/REST-supplied arguments into the leaf's input shape.
 * Returns a model-facing (and 400-worthy) message on the first problem.
 */
export function validateGenerateImageArgs(args: Record<string, any>): { ok: true; input: GenerateImageArgs } | { ok: false; message: string } {
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : '';
  if (prompt.length < IMAGE_PROMPT_MIN) {
    return { ok: false, message: `generate_image needs a \`prompt\` of at least ${IMAGE_PROMPT_MIN} characters — describe the picture in full sentences (subject, setting, style, lighting, composition, colours).` };
  }
  if (prompt.length > IMAGE_PROMPT_MAX) {
    return { ok: false, message: `generate_image: the prompt is ${prompt.length} characters — keep it under ${IMAGE_PROMPT_MAX}.` };
  }
  let aspect: ImageAspect | undefined;
  if (args?.aspect !== undefined && args?.aspect !== null && String(args.aspect).trim() !== '') {
    const a = String(args.aspect).trim().toLowerCase();
    if (!IMAGE_ASPECTS.has(a)) {
      return { ok: false, message: `generate_image: invalid aspect ${JSON.stringify(args.aspect)} — use one of square, landscape, portrait, wide, tall.` };
    }
    aspect = a as ImageAspect;
  }
  let style: string | undefined;
  if (args?.style !== undefined && args?.style !== null && String(args.style).trim() !== '') {
    style = String(args.style).trim();
    if (style.length > IMAGE_STYLE_MAX) return { ok: false, message: `generate_image: \`style\` must be ${IMAGE_STYLE_MAX} characters or fewer.` };
  }
  let negativePrompt: string | undefined;
  if (args?.negativePrompt !== undefined && args?.negativePrompt !== null && String(args.negativePrompt).trim() !== '') {
    negativePrompt = String(args.negativePrompt).trim();
    if (negativePrompt.length > IMAGE_NEGATIVE_MAX) return { ok: false, message: `generate_image: \`negativePrompt\` must be ${IMAGE_NEGATIVE_MAX} characters or fewer.` };
  }
  return { ok: true, input: { prompt, aspect, style, polish: args?.polish === true, negativePrompt } };
}

export type ImageReference = NonNullable<GenerateImageInput['reference']>;

/**
 * Resolve the optional reference image: an earlier generated image (File id,
 * same user) or an attached upload (uploadId — ownership + 15-min expiry
 * semantics copied from fill_pdf_form). Bytes are size-capped and SNIFFED; a
 * non-image never reaches a provider. `status` is the REST mirror's code.
 */
export async function resolveImageReference(
  userId: string,
  args: { referenceFileId?: unknown; referenceUploadId?: unknown },
): Promise<{ ok: true; reference?: ImageReference } | { ok: false; message: string; status: 400 | 404 }> {
  const referenceFileId = typeof args.referenceFileId === 'string' ? args.referenceFileId.trim() : '';
  const referenceUploadId = typeof args.referenceUploadId === 'string' ? args.referenceUploadId.trim() : '';
  const check = (bytes: Buffer, declared: string | undefined, label: string): { ok: true; reference: ImageReference } | { ok: false; message: string; status: 400 } => {
    if (bytes.length === 0) return { ok: false, status: 400, message: `${label} is empty — it cannot be used as a reference image.` };
    if (bytes.length > MAX_IMAGE_BYTES) {
      return { ok: false, status: 400, message: `${label} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB — reference images must be ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB or smaller.` };
    }
    const sniffed = sniffGeneratedImageMime(bytes);
    if (!sniffed) return { ok: false, status: 400, message: `${label} is not a PNG, JPEG or WebP image${declared ? ` (declared ${declared})` : ''} — generate_image can only use one of those as a reference.` };
    return { ok: true, reference: { bytes, mimeType: sniffed } };
  };
  if (referenceFileId) {
    const file = await prisma.generatedFile.findFirst({ where: { id: referenceFileId, userId } });
    if (!file) {
      return { ok: false, status: 404, message: `No generated file with id ${referenceFileId} belongs to this user. Call list_files to see the current files.` };
    }
    if (!String(file.mimeType || '').toLowerCase().startsWith('image/')) {
      return { ok: false, status: 400, message: `File ${file.filename} is a ${file.format}, not an image — generate_image can only use an image as a reference.` };
    }
    const r = check(Buffer.from(file.data, 'base64'), file.mimeType, `File ${file.filename}`);
    if (!r.ok) return r;
    return { ok: true, reference: { ...r.reference, name: file.filename } };
  }
  if (referenceUploadId) {
    const rawUpload = await loadAttachment(referenceUploadId);
    // M2 (fill_pdf_form precedent): an upload owned by a DIFFERENT account is
    // treated exactly like a missing one — same message, no existence leak.
    const upload = rawUpload && rawUpload.ownerUserId != null && rawUpload.ownerUserId !== userId ? null : rawUpload;
    if (!upload) {
      return { ok: false, status: 404, message: `Upload ${referenceUploadId} expired or was not found — attachments live for ~15 minutes after upload. Ask the user to re-attach the image, then retry generate_image with the new referenceUploadId.` };
    }
    if (upload.type !== 'image' || !upload.base64) {
      return { ok: false, status: 400, message: `Upload ${referenceUploadId} is a ${upload.type}, not an image — generate_image can only use an image attachment as a reference.` };
    }
    const r = check(Buffer.from(upload.base64, 'base64'), upload.mimeType, `Upload ${upload.filename || referenceUploadId}`);
    if (!r.ok) return r;
    return { ok: true, reference: { ...r.reference, name: upload.filename } };
  }
  return { ok: true };
}

export type ImageSlots =
  | { ok: true; refund: () => Promise<void> }
  | { ok: false; scope: 'chat_hourly' | 'user_daily'; cap: number; message: string };

/**
 * Take one image slot from the per-chat hourly and per-user daily counters
 * (consumed BEFORE the provider call; the caller refunds on any failure so a
 * failed attempt never eats budget). Redis unreachable → ALLOW (the
 * notify/knowledge fail-open posture) with a no-op refund. `chatKey` is the
 * run's chat id, or a per-user sentinel for chat-less runs — never a global
 * bucket shared across users.
 */
export async function takeImageGenerationSlots(userId: string, chatKey: string): Promise<ImageSlots> {
  const hourlyCap = imageChatHourlyCap();
  const dailyCap = imageUserDailyCap();
  try {
    const [{ rateKeys, consumeRateSlots, HOUR_KEY_TTL, DAY_KEY_TTL }, { default: redis }] = await Promise.all([
      import('./platform/rate-slots'),
      import('../../config/redis'),
    ]);
    const { hourKey, dayKey } = rateKeys('image', userId, chatKey);
    const verdict = await consumeRateSlots(redis, [
      { key: hourKey, cap: hourlyCap, ttlSec: HOUR_KEY_TTL, scope: 'chat_hourly' },
      { key: dayKey, cap: dailyCap, ttlSec: DAY_KEY_TTL, scope: 'user_daily' },
    ]);
    if (!verdict.ok) {
      const message = verdict.scope === 'chat_hourly'
        ? `This chat has already generated ${verdict.cap} images this hour (cap ${verdict.cap}/hour per chat). Tell the user and do not retry this run.`
        : `The user has already generated ${verdict.cap} images today (cap ${verdict.cap}/day). Tell the user; do not retry this run.`;
      return { ok: false, scope: verdict.scope, cap: verdict.cap, message };
    }
    let refunded = false;
    return {
      ok: true,
      refund: async () => {
        if (refunded) return;
        refunded = true;
        for (const k of [hourKey, dayKey]) {
          await redis.decr(k).catch(() => { /* best effort — an over-count only makes the cap stricter */ });
        }
      },
    };
  } catch (err: any) {
    logger.warn(`generate_image: rate-slot check unavailable (${scrubImageSecrets(err?.message || String(err))}) — allowing`);
    return { ok: true, refund: async () => { /* nothing was taken */ } };
  }
}

/** yyyymmdd-hhmmss (UTC) for generated image filenames. */
function imageFileStamp(d = new Date()): string {
  const iso = d.toISOString(); // 2026-09-24T14:03:22.123Z
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/** Filename-safe slug of the prompt (≤ max chars, never empty). */
function imageFileSlug(prompt: string, max: number): string {
  const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, max).replace(/-+$/, '');
  return slug || 'image';
}

/** Human caption for a generated image part ('Generated · 1024×1024 · "a red fox…"'). */
export function generatedImageCaption(img: Pick<GeneratedImage, 'width' | 'height'>, prompt: string): string {
  const dims = img.width && img.height ? `${img.width}×${img.height}` : null;
  const short = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  return `Generated${dims ? ` · ${dims}` : ''} · "${short}"`;
}

/**
 * Persist one generated image as a GeneratedFile row (the same store the
 * document tools use — Files page, list_files, read_document all see it).
 * format/mimeType come from the magic-byte sniff, never the provider's label;
 * the per-user quota is enforced first (GeneratedFileQuotaError on refusal).
 */
export async function storeGeneratedImage(
  userId: string,
  chatId: string | null,
  img: GeneratedImage,
  meta: { prompt: string; aspect?: string; style?: string },
): Promise<{ id: string; filename: string }> {
  const mimeType = sniffGeneratedImageMime(img.bytes) ?? img.mimeType;
  const format = IMAGE_FORMAT_BY_MIME[mimeType];
  if (!format) throw new Error(`Unsupported generated image type ${mimeType} — expected PNG, JPEG or WebP.`);
  const quotaErr = await generatedFileQuotaError(userId, img.bytes.length, { newRow: true, surface: 'image' });
  if (quotaErr) throw new GeneratedFileQuotaError(quotaErr);
  const filename = `image-${imageFileStamp()}-${imageFileSlug(meta.prompt, 32)}.${format}`;
  const dims = img.width && img.height ? `${img.width}×${img.height}` : 'size unknown';
  const record = await createGeneratedFileRow({
    userId,
    chatId,
    filename,
    format,
    mimeType,
    size: img.bytes.length,
    data: img.bytes.toString('base64'),
    textContent: `[Generated image] prompt: "${meta.prompt}" | model: ${img.model} (${img.provider}) | ${dims} | aspect ${meta.aspect ?? 'square'}${meta.style ? ` | style: ${meta.style}` : ''} | reference: ${img.referenceMode}`,
  }, 'image');
  logger.info(`Generated image stored: ${filename} (${mimeType}, ${img.bytes.length} bytes, ${img.model} via ${img.provider}) → file ${record.id} user=${userId}`);
  return { id: record.id, filename };
}

/** loop_metrics kind `image_generation` — fire-and-forget, never throws. */
export async function recordImageGenerationMetric(
  sessionId: string | null | undefined,
  latencyMs: number,
  meta: Record<string, unknown>,
): Promise<void> {
  try {
    const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('./platform/loop-metrics.service');
    recordLoopMetric({ kind: LOOP_METRIC_KINDS.IMAGE_GENERATION, sessionId: sessionId ?? undefined, value: latencyMs, unit: 'ms', meta });
  } catch { /* telemetry never breaks the surface */ }
}

// ── Tool Definitions (OpenAI function calling format) ──────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_engine',
      description: 'Search the web (Google) and get the results LIST — titles, links, snippets. Use it to discover what exists or answer from snippets (current events, prices, scores, facts that change). If you expect to READ several of the results, call web_pipe instead — it searches AND reads in one step.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query. Be specific and concise — e.g. "TSLA stock price today" not "What is the current price of Tesla stock?"',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'scrape_as_markdown',
      description: 'Read ONE specific webpage verbatim, returned as Markdown. Use when you need the exact content of a known URL (the user gave it, or precision matters — quotes, tables, numbers). For reading and digesting SEVERAL pages, call web_pipe instead.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The full URL to fetch (must start with http:// or https://)',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_image',
      description: "Fetch ONE external image URL and attach it to your reply so the user sees the actual picture inline (instead of describing it). Use when the user shares a direct image link (a .png/.jpg/.webp/.gif URL) and wants it shown, or when a page's key content is an image you already have the direct URL for. The URL must be http(s) and the image under 5MB. NOT for reading text from a page — use scrape_as_markdown for that.",
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The direct image URL (must start with http:// or https://)',
          },
          name: {
            type: 'string',
            description: "Optional caption shown under the image (defaults to the URL's filename).",
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_task',
      // build 2026-10-08 A2-3 (tool diet): provenance — feedback 88915954 (always disclose the separate LOCAL
      // profile), ticket 8fe9429c (read-only workers are camera-only), feedback 4258335e (CDP attach).
      description: 'Delegate a mini-task to a browser agent that drives a real browser step by step (navigate, read, follow links; click and type when the user has a paired computer). Use ONLY when search_engine and the scrape tools are not enough — multi-step navigation, interacting with a page, or the user asked to do something ON a website. Describe the task fully (include any known URL). Destinations, chosen automatically: CLOUD (hosted, read-mostly, always available); LOCAL (Digby\'s OWN browser profile on the user\'s paired computer — click/type, signed in only where they logged in THROUGH Digby, not their everyday Chrome/Safari/Edge); COMPUTER (hands off to computer_task). If the user names their own browser, an app or their screen, call computer_task directly. The result header names the destination and the device status — relay it when asked. When the LOCAL destination ran, your answer MUST ALWAYS state plainly that it used a separate Digby browser profile on their computer — never describe it as just "their real browser" or "not headless". From a read-only worker the COMPUTER destination is camera-only (look, never act).',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Complete, self-contained description of what to accomplish in the browser (goal + any constraints + what to report back).',
          },
          url: {
            type: 'string',
            description: 'Optional starting URL if known (must start with http:// or https://).',
          },
          attach: {
            type: 'boolean',
            description: 'OPT-IN per task (default false): run in a NEW TAB of the user\'s EVERYDAY signed-in Chrome via CDP attach — only when they asked for their own Chrome. Needs desktop agent v0.5.0+ with attach enabled and Chrome started with --remote-debugging-port=9222, else Digby\'s profile runs (the header says which — relay it). Attached mode never types into password fields or submits forms.',
          },
          device: {
            type: 'string',
            description: 'Which paired computer to use (its label, e.g. "MacBook Pro") when the user has several; omit for their default.',
          },
        },
        required: ['task'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'computer_task',
      // build 2026-10-08 A2-3 (tool diet): provenance — ticket ac9022a0 (the write-path watchdog), ticket 8fe9429c
      // (read-only workers are camera-only).
      // Budget row raised (was 1054): the one-line long-sequence warning is the moment-of-decision
      // nudge for the silent-stall class — a run that eats its whole step budget on a multi-GB
      // device install ends with a promised "next turn" nothing wakes. Keep it within one sentence.
      description: 'FULL computer use — operate the user\'s own computer (Mac or Windows PC): SEE the screen and ACT on it (click, type, keys, scroll, open apps) step by step with live screenshots, in whatever they already use — their everyday browser with ALL their logins, tabs and extensions, and any installed app (Mail, Calendar, Slack, Notes, IDEs, Settings…). Use it when the user asks for something ON their computer or IN their browser/app ("in Chrome", "check my Mail", "what\'s on my screen", "on my PC"), when a task needs their existing logged-in session (browser_task\'s local browser is a separate profile), or when an app has no integration. It acts autonomously and asks only when truly stuck (a password only they know). Needs their Digby desktop app paired and online — no cloud fallback. Relay the result header\'s device status and any permission-setup instructions verbatim. If it reports input produced NO VISIBLE CHANGE, relay the fix verbatim and do NOT retry until the device side is repaired. From a read-only worker it is camera-only (input refused). Long device work (multi-GB installs) can eat the whole step budget: arm a one-shot schedule_self first; cancel it once the work lands.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Complete, self-contained description of what to accomplish on the computer (goal + constraints + what to report back).',
          },
          device: {
            type: 'string',
            description: 'Which paired computer to drive (its label, e.g. "MacBook Pro") when the user has several; omit for their default. If the task text names a paired device, that machine is auto-bound even when this is omitted — and the result header says so; when the text names SEVERAL paired devices and this is omitted, the call is refused. Pass the device explicitly for machine-specific tasks.',
          },
        },
        required: ['task'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'web_pipe',
      description: 'Deterministic research pipeline in ONE call: searches the web (or takes your URLs), reads the top pages in parallel, and returns a compact digest of key facts with sources — a fast helper model does the reading so the pages never flood your context. Prefer this over search_engine + scrape chains whenever you need MULTIPLE pages understood; use scrape_as_markdown only for one specific page you must read verbatim.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query — the pipe reads the top organic results. Omit if you pass urls.' },
          urls: { type: 'array', items: { type: 'string' }, description: 'Specific URLs to ingest (max 4). Takes precedence over query.' },
          focus: { type: 'string', description: 'Optional: what the digest should focus on.' },
        },
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'youtube_pipe',
      description: 'Deterministic YouTube ingestion in ONE call: finds videos by query (or takes your YouTube URLs), pulls the transcript (captions fast path, local open-source STT slow fallback), and returns a compact digest of the key facts per video. Use when the answer may live in VIDEO content (talks, tutorials, interviews, lectures, reviews) that scrape_as_markdown cannot read.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query — the pipe picks the top YouTube videos. Omit if you pass urls.' },
          urls: { type: 'array', items: { type: 'string' }, description: 'Specific YouTube video URLs to ingest (max 4). Takes precedence over query.' },
          focus: { type: 'string', description: 'Optional: what the digest should focus on.' },
          stt: { type: 'boolean', description: 'Set false to skip the slow audio-transcription fallback (captions only).' },
        },
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'create_document',
      description: 'Create a downloadable FILE (txt, md, csv, json, xlsx, docx or pdf) saved to the user\'s Files page — use it whenever the user asks for a document, spreadsheet, report, letter, invoice or any artifact to keep or download, instead of pasting a long document into chat. The format follows the filename extension (or `format`). xlsx: `sheets` (array of {name, rows}) for several sheets, or CSV/tab-separated `content` for one. docx: `content` may use markdown (headings, bold/italic, code, bullet/numbered lists, pipe tables, quotes) and renders styled — use it for anything a human will read. pdf: `content` is the body (blank lines split paragraphs), `title` adds a heading. Render the returned download link EXACTLY as returned — never a file: scheme or any other URL shape.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'File name with extension, e.g. "q3-report.xlsx" or "cover-letter.docx".' },
          format: { type: 'string', enum: ['txt', 'md', 'csv', 'json', 'xlsx', 'docx', 'pdf'], description: 'Optional explicit format — inferred from the filename extension when omitted.' },
          content: { type: 'string', description: 'The full document content (plain text / CSV / markdown / JSON string). For xlsx without `sheets`: one row per line, cells tab- or comma-separated.' },
          sheets: {
            type: 'array',
            description: 'xlsx only: one entry per worksheet. Each row is an array of cell values (string | number | boolean | null).',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                rows: { type: 'array', items: { type: 'array', items: {} } },
              },
              required: ['name', 'rows'],
            },
          },
          title: { type: 'string', description: 'Optional document title (docx/pdf: rendered as a heading).' },
          chatId: { type: 'string', description: 'Optional. Ignored when this run already belongs to a chat — the file is always filed under the chat you are working in. Only a run with no chat context may name one of the user\'s own chats here.' },
        },
        required: ['filename'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'read_document',
      description: 'Read the text of one of the user\'s own files: pass fileId for an agent-generated file (from create_document / list_files) or documentId for a knowledge-base document. For generated PDFs with an AcroForm, the form field names are listed too — use them with fill_pdf_form. Returns the plain-text rendering. Long documents are PAGED, not truncated: use offset/limit to read them in slices — the header always states the FULL text\'s total length and sha256 hash, so after paging through every slice you can reassemble and hash-verify completeness.',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'id of a generated file (from create_document / list_files).' },
          documentId: { type: 'string', description: 'id of a knowledge-base document (from list_files).' },
          offset: { type: 'number', description: '0-based character offset into the stored text (default 0).' },
          limit: { type: 'number', description: 'Max characters to return (default 50000, hard cap 50000).' },
        },
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'list_files',
      description: 'List the user\'s files in two groups: GENERATED files (created by create_document — downloadable, have a File id) and KNOWLEDGE documents (uploaded/added to projects — have a Document id). Use before read_document/update_document/fill_pdf_form when you don\'t already have the id, and to answer "what files do I have?".',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'update_document',
      description: 'Regenerate an existing agent-generated file with NEW content (same filename and format) — use when the user asks to change, extend, or correct a file you created earlier. Pass the full replacement content (or sheets), not a diff. The file keeps its id and its place on the user\'s Files page.',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'id of the generated file to update (from create_document / list_files).' },
          content: { type: 'string', description: 'Full replacement content.' },
          sheets: {
            type: 'array',
            description: 'xlsx only: replacement worksheets (same shape as create_document).',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                rows: { type: 'array', items: { type: 'array', items: {} } },
              },
              required: ['name', 'rows'],
            },
          },
          title: { type: 'string', description: 'Optional replacement title (docx/pdf).' },
        },
        required: ['fileId'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'fill_pdf_form',
      description: 'Fill an AcroForm PDF form and save the filled PDF as a new downloadable file. `fields` keys must be the PDF\'s OWN form field names — for a generated PDF, call read_document on it first (it lists the form field names); for an uploaded PDF, pass uploadId (the id shown in the attachment context for the uploaded PDF) and reuse the field names visible in its text. Checkbox fields take true/yes/1/on. Unknown field names are reported back, never silently dropped.',
      parameters: {
        type: 'object',
        properties: {
          fields: { type: 'object', description: 'Map of form field name → value to set (all values as strings).' },
          fileId: { type: 'string', description: 'id of a generated PDF file (from create_document / list_files).' },
          uploadId: { type: 'string', description: 'uploadId of an uploaded PDF attachment (shown in the attachment context line). Attachments expire ~15 min after upload — if expired, ask the user to re-upload.' },
        },
        required: ['fields'],
      },
    },
  },

  {
    type: 'function' as const,
    function: {
      name: 'generate_image',
      description: 'Create a NEW picture from a text prompt (illustration, logo concept, mockup, poster, icon, photo-style scene, character art) — whenever the user asks you to draw, make, generate, design or "show me" an image, or to edit/re-style an image they attached. NOT for charts or tables from data (create_document), screenshots (browser_task / computer_task) or diagrams wanted as editable code (a mermaid canvas). Write the prompt in full sentences: subject, setting, style, lighting, composition, colours; quote any words that must appear in the image. It is saved to Files and ALREADY shown in the chat under this call — never paste base64 or embed it again; say what you made and offer one revision. referenceUploadId (an attached image) or referenceFileId (an earlier one) edits that image.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Full image prompt, 3–2000 characters.' },
          aspect: { type: 'string', enum: ['square', 'landscape', 'portrait', 'wide', 'tall'], description: 'Shape (default square ≈1024×1024; landscape 4:3, portrait 3:4, wide 16:9, tall 9:16).' },
          style: { type: 'string', description: 'Optional style hint appended to the prompt, e.g. "flat vector, two colours" or "35mm film photo" (≤200 chars).' },
          polish: { type: 'boolean', description: 'Let the provider expand/rewrite the prompt for richer detail (slower: tens of seconds). Default false.' },
          negativePrompt: { type: 'string', description: 'Things to avoid (≤500 chars). Supported by the DashScope models; ignored elsewhere.' },
          referenceUploadId: { type: 'string', description: 'uploadId of an attached image (from the attachment context line) to edit or re-style.' },
          referenceFileId: { type: 'string', description: 'File id of an image generated earlier (from list_files / a previous generate_image result).' },
          chatId: { type: 'string', description: 'Optional. Ignored when this run already belongs to a chat (same rule as create_document).' },
        },
        required: ['prompt'],
      },
    },
  },
];

// ── Request-Scoped Tool Cache ──────────────────────────────────────────────────

/**
 * Per-request cache for tool results.
 * Create ONE instance per pipeline invocation and share across all 3 models.
 * When Model A calls web_search("TSLA stock price"), the result is cached.
 * When Model B calls the same, it gets the cached result instantly.
 */
export class ToolCache {
  private cache = new Map<string, string>();
  private pending = new Map<string, Promise<string>>();
  public hits = 0;
  public misses = 0;
  /** Screenshots captured by browser_task / computer_task since the last
   *  takeAttachedImages() — the agent loop drains them into the transcript
   *  right after the tool's result part (see AttachedImage). */
  private attachedImages: AttachedImage[] = [];

  /** Drain the screenshots attached since the last call (FIFO). */
  takeAttachedImages(): AttachedImage[] {
    const out = this.attachedImages;
    this.attachedImages = [];
    return out;
  }

  /**
   * @param userId Signed-in user the request belongs to (null for anonymous).
   *               Required by browser_task to route to the user's paired local
   *               browser; the shared cache also dedupes a browser task fired
   *               by multiple models in parallel into ONE session. The document
   *               tools (create_document etc.) require it too — generated files
   *               are owned per-user.
   * @param chatId Chat the current run belongs to (null/omitted when the run
   *               has no chat — ticket 8db4c18e). create_document/fill_pdf_form
   *               ALWAYS attribute their files to it (the Files sidebar filters
   *               by chatId); since 2026-09-22 the model's optional chatId arg
   *               is honored only when this is null AND names one of the
   *               user's own chats — see generatedFileChatId.
   * @param onAgentEvent Optional UI-event sink (UI Phase 6a): browser_task
   *               forwards its sub-session's per-action `browser_observation`
   *               events through it into the calling run's event stream (the
   *               coding lane's pushRunEvent / the chat lane's SSE adapter).
   *               Omitted → the old discard behavior, byte-identical results.
   * @param opts Ticket 8fe9429c (2026-09-25): `computerInputMode: 'observe'`
   *               marks this cache as belonging to a delegated read-only
   *               WORKER — its browser_task / computer_task sub-sessions run
   *               the user's paired desktop CAMERA-ONLY (screenshots and reads
   *               allowed; every synthetic-input action refused at the
   *               computer-loop dispatch gate, before anything is dispatched
   *               to the device). Absent = 'full' (the orchestrator/lead keeps
   *               the historical behavior). The incident: an observation
   *               sub-agent quit Terminal on the harvest Mac via browser_task's
   *               COMPUTER handoff, killing a nohup'd tar+scp transfer.
   */
  constructor(
    userId: string | null = null,
    private readonly chatId: string | null = null,
    private readonly onAgentEvent?: (type: string, data: any) => void,
    private readonly opts: { computerInputMode?: 'full' | 'observe' } = {},
  ) {
    // Ticket e4d345a9: guest runs arrive with the sentinel 'anonymous'
    // (chat-agent.service.ts `runUserId = userId || 'anonymous'`) or an
    // `anon-…` session key. Every per-user surface here already guards on
    // `if (!this.userId)`, but a TRUTHY sentinel walked past those guards into
    // `generated_files` (NOT NULL + FK to users) and raised P2003 on every
    // guest generate_image / create_document. Normalizing at the single
    // construction seam fixes the whole class at once, and keeps the sentinel
    // where it belongs: the FK-less key-value stores that key on it.
    this.userId = normalizeToolUserId(userId);
  }

  /** Signed-in owner of this run, or null for a guest/anonymous run. */
  private readonly userId: string | null;

  /** cu-diag 2026-09-25 fix #6: the run's provenance for computer use —
   *  `machineTriggered` (supervisor wake / schedule / lane, not a human turn)
   *  drives the owner-presence gate; `lane` is the human-readable holder
   *  label recorded next to the device use-lock. Set once by agentLoop right
   *  after construction (a setter so the pinned constructor call stays
   *  byte-identical). */
  private runCtx: { machineTriggered?: boolean; lane?: string | null } = {};
  setRunContext(ctx: { machineTriggered?: boolean; lane?: string | null }): void {
    this.runCtx = { ...this.runCtx, ...ctx };
  }

  /**
   * WEB-2 (goal 9ecd595e, WRP-1 defects D1/D2/D3): per-run search route state,
   * one cluster per question. The Polk County run spent three searches
   * restating the same headline, never changed route, and had no recency bound.
   * Living on the executor means the budget is per run (the cache instance is
   * created per pipeline invocation), so it dies with the run that spent it.
   */
  private searchRoutes: RouteCluster[] = [];

  /**
   * The chat this cache's run belongs to (null when the run has no chat).
   * Ticket c42e8099: a tool-argument rejection must be attributable to a CHAT
   * so a lane degrading silently shows up per-chat on fleet telemetry — the
   * reporter's whole complaint was that five cuts were invisible to it.
   */
  chatScopeId(): string | null {
    return this.chatId;
  }
  private computerProvenance(): { machineTriggered?: boolean; holder?: { chatId: string | null; lane: string | null } } {
    return {
      ...(this.runCtx.machineTriggered === true ? { machineTriggered: true } : {}),
      holder: { chatId: this.chatId, lane: this.runCtx.lane ?? null },
    };
  }

  private normalizeKey(toolName: string, args: Record<string, any>): string {
    // Normalize: lowercase tool name, sort args keys, trim string values
    const normalizedArgs: Record<string, any> = {};
    for (const [key, value] of Object.entries(args)) {
      normalizedArgs[key] = typeof value === 'string' ? value.trim().toLowerCase() : value;
    }
    return `${toolName.toLowerCase()}:${JSON.stringify(normalizedArgs, Object.keys(normalizedArgs).sort())}`;
  }

  /**
   * The chat a generated file is filed under (owner report 2026-09-22: "files
   * from another project session are appearing in a different project
   * session's chat sidebar"). The run's own chat ALWAYS wins — a model-supplied
   * id can only mis-attribute a file into another session's Files sidebar. A
   * run with no chat context (some machine paths) may name a chat, but only one
   * of this user's own; anything else stays unattributed.
   */
  async generatedFileChatId(requested: unknown): Promise<string | null> {
    if (this.chatId) return this.chatId;
    const id = typeof requested === 'string' ? requested.trim() : '';
    if (!id || !this.userId) return null;
    try {
      const own = await prisma.crossModelChat.findFirst({ where: { id, userId: this.userId }, select: { id: true } });
      return own ? own.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Get a cached result or execute the tool call.
   * Uses a pending-promise pattern to prevent duplicate in-flight requests:
   * if Model A's request is still pending when Model B asks for the same thing,
   * Model B awaits the same promise rather than firing a second BrightData call.
   */
  async getOrExecute(toolName: string, args: Record<string, any>): Promise<string> {
    // Document tools hit live per-user DB state — bypass the cache entirely
    // (see DOC_TOOL_NAMES): correctness beats a deduped DB read.
    if (DOC_TOOL_NAMES.has(toolName)) {
      this.misses++;
      return this.executeToolCall(toolName, args);
    }
    const key = this.normalizeKey(toolName, args);

    // Check cache
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.hits++;
      logger.info(`ToolCache HIT: ${toolName}(${JSON.stringify(args).substring(0, 60)}) — ${cached.length} chars`);
      return cached;
    }

    // Check if there's already an in-flight request for this exact call
    const pending = this.pending.get(key);
    if (pending) {
      this.hits++;
      logger.info(`ToolCache PENDING HIT: ${toolName}(${JSON.stringify(args).substring(0, 60)}) — awaiting in-flight request`);
      return pending;
    }

    // Cache miss — execute the tool call
    this.misses++;
    const promise = this.executeToolCall(toolName, args);
    this.pending.set(key, promise);

    try {
      const result = await promise;
      this.cache.set(key, result);
      this.pending.delete(key);
      return result;
    } catch (error) {
      this.pending.delete(key);
      throw error;
    }
  }

  private async executeToolCall(toolName: string, args: Record<string, any>): Promise<string> {
    try {
      switch (toolName) {
        case 'search_engine': {
          const query = args.query || '';
          logger.info(`ToolExecutor: search_engine("${query.substring(0, 80)}")`);
          // ── WEB-2 route policy (goal 9ecd595e / WRP-1 D1·D2·D3) ───────────
          // The Polk County run spent three searches restating one headline,
          // never changed source class, and carried no recency bound. The plan
          // is per QUESTION: a paraphrase of a spent attempt is refused with the
          // next route named, an undated question is searched as-is, and a
          // news-shaped one is hard-bounded to the window its own framing implies.
          const routeOff = process.env.WEB_SEARCH_ROUTE_LADDER_DISABLED === '1';
          const plan = routeOff ? null : planNextRouteForRun(query, this.searchRoutes);
          if (plan && plan.action === 'refuse') {
            return `NOT SEARCHED — ${plan.reason}. Do not re-issue this query. `
              + (plan.route ? `Next: reach the same subject through the ${ROUTE_LABEL[plan.route]} route` : 'Report what is already verified')
              + ` (the sources already returned stay usable; quote them instead of searching again).`;
          }
          if (plan && plan.action === 'exhausted') {
            return exhaustedSearchMessage(query, this.searchRoutes.flatMap((c) => c.state.routes));
          }
          const effectiveQuery = plan?.query || query;
          if (plan && plan.recency.label) {
            logger.info(`ToolExecutor: recency bound ${plan.recency.window} (${plan.recency.source}) on "${query.substring(0, 60)}"`);
          }
          // SERP provider-error surfacing (ticket ca805a61): the search tier now
          // classifies a provider error/debug body as a FAILED attempt and
          // returns the honest null — the callback hands this surface the
          // classified detail so the agent sees an EXPLICIT backend failure
          // (throttle vs query-block) instead of a bare "no results", which
          // reads as "nothing exists" while the provider is down.
          const serpErr: { d: SerpProviderError | null } = { d: null };
          const result = await callMcpTool('search_engine', { query: effectiveQuery, engine: 'google' }, undefined, {
            onSerpProviderError: (d) => { if (!serpErr.d) serpErr.d = d; },
          });
          if (!routeOff) recordAttempt(clusterFor(query, this.searchRoutes).cluster.state, query, plan?.route || 'serp', !!result);
          if (!result) {
            // Ticket 6f4d42f2: an instance with NO search credentials (no env
            // key, no admin-store key, no gateway token) must say SO — the
            // generic degraded/unreachable wording sent the owner's self-hosted
            // chat into 9 futile searches with no actionable message.
            const cfg = lastSearchConfigState();
            if (cfg && !cfg.anyBackendArmed) {
              return SEARCH_NOT_CONFIGURED_MSG;
            }
            if (serpErr.d) {
              const d = serpErr.d;
              const deterministic = (d.code || '').toLowerCase() === 'unexpected_q';
              // The ca805a61 contract: a provider error must ALWAYS surface as an
              // explicit "Web search failed … x-brd-error-code=…" — never the vendor
              // text as results, never a bare "no results" that reads as "nothing
              // exists". Every branch below builds on this line; a branch that
              // replaces it regresses the ticket (shard-3, 2026-10-31).
              const failureMsg = `Web search failed — the search provider answered with an error instead of results (SERP error${d.code ? `, x-brd-error-code=${d.code}` : ''}${d.status ? `, HTTP ${d.status}` : ''}). This is a provider-side failure, NOT an indication that no results exist.${deterministic ? ' The query was rejected as a mismatch — rephrase it (retrying the identical query fails the same way).' : ' Wait briefly (the provider documents a ~15 s floor for query-level bans) and retry, or rephrase the query.'} Do not treat this as an empty topic: use other tools, your own knowledge, or retry web search shortly.`;
              // WEB-2 D3: a throttle/transient shape is NOT something the USER is
              // told about — the message points the MODEL at the next route and
              // forbids narrating the failure into the deliverable. It AUGMENTS the
              // explicit failure, it does not replace it: retrying the same route is
              // futile, but the agent must still see that the backend failed.
              // PRECEDENCE: a DETERMINISTIC rejection (unexpected_q — retrying is
              // futile) is never "transient", even when the provider answers 5xx;
              // else a query-mismatch takes the rotate path and loses the rephrase
              // guidance (shard-3, 2026-10-31).
              if (!routeOff && !deterministic && isTransientSearchFailure(d)) {
                const nextRoute = nextRouteClass(this.searchRoutes.flatMap((c) => c.state.routes));
                return `${failureMsg} ROUTING: this route is temporarily rate-limited — `
                  + (nextRoute ? `rotate to the ${ROUTE_LABEL[nextRoute]} route now` : 'the ladder is spent — answer from what is already verified')
                  + ' and do NOT mention throttling, retries or routing in your reply: the user gets the verified/unverified split, not the plumbing.';
              }
              return failureMsg;
            }
            return webNullResultMsg('No search results found. Try a different query.');
          }
          // D2: tell the model what window the results answer — so the answer can
          // say "past week" instead of presenting a 2022 item as current.
          const recencyNote = plan?.recency.label
            ? `\n\n[recency: results bounded to the ${plan.recency.label} (after:${plan.recency.afterDate}); items older than that were excluded. If a detail is missing, say it is unconfirmed for this window — do not widen it silently.]`
            : '';
          return result + recencyNote;
        }

        case 'scrape_as_markdown': {
          const url = args.url || '';
          // BS-1 D5 (2026-11-02): a truncated URL used to be dispatched verbatim
          // and come back as a raw gateway `400 "url" must be a valid uri`, which
          // reads to the model as an infrastructure fault. Fail here instead, in
          // words it can act on ("this link was cut off — get the whole URL").
          const verdict = preflightUrl(url);
          if (!verdict.ok) {
            logger.info(`ToolExecutor: scrape_as_markdown REFUSED pre-dispatch (${verdict.kind})`);
            return verdict.reason!;
          }
          logger.info(`ToolExecutor: scrape_as_markdown("${url.substring(0, 80)}")`);
          // BS-1 D4 (2026-11-02): an EMPTY scrape used to be reported as "the page
          // may be unavailable, blocked, or rate-limited" — i.e. the site is down —
          // which is what a guessed/fabricated path produces. Wire the long-dormant
          // resolveDomainUrl primitive in: ask the SERP what the real url for this
          // domain is, retry it once, and say NOT FOUND (never "down") if that
          // fails too. The ladder is bounded: one search, one retry.
          const ladder = await scrapeViaDomainResolve(url, {
            scrape: async (target: string) => {
              const r = await callMcpTool('scrape_as_markdown', { url: target }).catch(() => null);
              return typeof r === 'string' && r.trim() ? r : null;
            },
            search: async (query: string) => {
              const serp = await callMcpTool('search_engine', { query: query.slice(0, 200), engine: 'google' }).catch(() => null);
              if (typeof serp === 'string') return serp;
              if (serp && typeof serp === 'object') return JSON.stringify(serp);
              return null;
            },
          });
          // Ticket 6f4d42f2: no search credentials anywhere = say so (see the
          // search_engine case above for the rationale).
          {
            const cfg = lastSearchConfigState();
            if (!ladder.ok && cfg && !cfg.anyBackendArmed) {
              return SEARCH_NOT_CONFIGURED_MSG;
            }
          }
          if (ladder.ok) {
            logger.info(`ToolExecutor: scrape_as_markdown OK via ${ladder.via}${ladder.resolvedUrl ? ` (${ladder.resolvedUrl.substring(0, 80)})` : ''}`);
            return ladder.markdown;
          }
          logger.info(`ToolExecutor: scrape_as_markdown NOT FOUND for ${verdict.host ?? url.slice(0, 60)} (searched=${ladder.searched})`);
          return ladder.message;
        }

        case 'fetch_image': {
          // e8ef6b04: fetch ONE external image URL and attach it to the reply
          // (the user sees the picture inline). Same URL-fetch trust boundary as
          // premise sources: http(s) only, SSRF-guarded host, bounded read.
          const rawUrl = String(args.url || '').trim();
          const caption = String(args.name || '').trim();
          if (!rawUrl) return 'No url provided for fetch_image.';
          let parsed: URL;
          try { parsed = new URL(rawUrl); } catch { return `Invalid URL: ${rawUrl}`; }
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return `fetch_image only supports http(s) URLs (got ${parsed.protocol}//). If you have a data: URI or local file, describe it instead.`;
          }
          const { isBlockedAddress, isBlockedHostname } = await import('./platform/premise-register');
          if (isBlockedHostname(parsed.hostname)) {
            return `Refusing to fetch "${parsed.hostname}" — internal hostname. fetch_image only fetches public internet hosts.`;
          }
          const bareHost = parsed.hostname.replace(/^\[|\]$/g, '');
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bareHost) || bareHost.includes(':')) {
            if (isBlockedAddress(bareHost)) {
              return `Refusing to fetch ${bareHost} — private/loopback/reserved address. fetch_image only fetches public internet hosts.`;
            }
          }
          logger.info(`ToolExecutor: fetch_image("${rawUrl.substring(0, 120)}")`);
          const MAX_BYTES = 5 * 1024 * 1024;
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 15_000);
          (timer as any).unref?.();
          let bytes: Buffer;
          let contentType: string | undefined;
          try {
            const res = await fetch(parsed, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Digby/1.0 (+https://digby.ai)' } });
            if (!res.ok) {
              return `Failed to fetch ${rawUrl}: HTTP ${res.status}. Do not retry this URL — answer from what you already have.`;
            }
            contentType = res.headers.get('content-type') || undefined;
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length === 0) return `Failed to fetch ${rawUrl}: the response body was empty.`;
            if (buf.length > MAX_BYTES) {
              return `Image too large: ${(buf.length / 1024 / 1024).toFixed(1)}MB exceeds the 5MB cap. Do not retry — tell the user the image is too large to attach.`;
            }
            bytes = buf;
          } catch (err: any) {
            if (err?.name === 'AbortError') return `Timed out fetching ${rawUrl} after 15s. Do not retry this URL.`;
            return `Failed to fetch ${rawUrl}: ${err?.message || 'network error'}. Do not retry this URL.`;
          } finally {
            clearTimeout(timer);
          }
          // Magic-byte sniff — never trust the declared content-type (a text/HTML
          // error page masquerading as an image must not become an image part).
          const magic = sniffImageMedia(bytes);
          if (!magic) {
            const got = contentType ? ` (server said ${contentType})` : '';
            return `The URL did not return a recognized image (png/jpeg/webp/gif)${got}. It may be an HTML page — use scrape_as_markdown for text content instead.`;
          }
          const nameFromUrl = decodeURIComponent((parsed.pathname.split('/').filter(Boolean).pop() || '').replace(/\+/g, ' '));
          const name = caption || nameFromUrl || 'fetched image';
          this.attachedImages.push({ mediaType: magic, data: bytes.toString('base64'), name, source: 'fetched', pageUrl: rawUrl });
          // No live emit here: BOTH lanes (chat + coding) drain
          // takeAttachedImages() at coding/agent.ts:3554, which persists the
          // image part AND emits the live `image` event — the browser/computer
          // screenshot idiom. Emitting here too would double-fire the live view.
          return `Fetched and attached image "${name}" (${magic}, ${(bytes.length / 1024).toFixed(0)}KB, from ${rawUrl}). It is now visible to the user in your reply. Describe what it shows if that helps.`;
        }

        case 'browser_task': {
          const task = String(args.task || '').trim();
          if (!task) return 'No task provided for the browser agent.';
          if (!this.userId) {
            return 'The browser agent is only available for signed-in users. Use search_engine or scrape_as_markdown instead and answer from those.';
          }
          logger.info(`ToolExecutor: browser_task("${task.substring(0, 100)}") user=${this.userId}`);
          // Dynamic import keeps module init order simple (no static cycle risk
          // between the tool layer and the browser-agent module).
          const { runBrowserAgentSession } = await import('./browser-agent');
          // Last screenshot frame of this sub-session → attached to the chat
          // as an image part once the tool returns (see AttachedImage).
          let lastShot: { data: string; mediaType: string; pageUrl?: string; app?: string; source: 'browser' | 'computer' } | null = null;
          const result = await runBrowserAgentSession({
            userId: this.userId,
            chatId: null,
            message: args.url ? `${task}\n\nStart at: ${args.url}` : task,
            // ea3ad8a8: hosted hardened browser — the persistent context is
            // scoped to the chat the tool runs in (this.chatId; worker
            // sub-sessions without a chat fall back to no hosted option).
            sessionKey: this.chatId ? `chat:${this.chatId}` : null,
            // 4258335e: per-task CDP-attach opt-in (the user asked for their own
            // Chrome) — requires a ≥0.5.0 agent + the owner-side switch; the
            // result reports the mode that ACTUALLY ran.
            attach: args.attach === true,
            // Multi-Mac (2026-09-24): run on a specific paired Mac when the
            // user has several and named one.
            ...(args.device ? { device: String(args.device) } : {}),
            // 8fe9429c: a read-only worker's cache marks its sub-sessions
            // observe-only at the device-input layer — the COMPUTER handoff
            // runs camera-only (screenshots allowed, input refused).
            ...(this.opts.computerInputMode === 'observe' ? { computerInputMode: 'observe' as const } : {}),
            // cu-diag fix #6: provenance for the COMPUTER handoff's
            // owner-presence gate + use-lock holder record.
            ...this.computerProvenance(),
            // Tool-delegated session: the calling model still narrates
            // (progress/chunk/confirm stay private; ask_user surfaces in the
            // returned text) — but the per-action browser-observation
            // transparency events forward up the calling run's event stream
            // (UI Phase 6a) so the browser panel can render a live view.
            sendEvent: (t: string, d: any) => {
              const fwd = forwardableBrowserObservation(t, d);
              if (!fwd) return;
              const shot = screenshotFromFrame(fwd.data);
              if (shot) {
                lastShot = {
                  ...shot,
                  source: fwd.data.driver === 'computer' ? 'computer' : 'browser',
                  pageUrl: typeof fwd.data.url === 'string' ? fwd.data.url : undefined,
                  app: typeof fwd.data.app === 'string' ? fwd.data.app : undefined,
                };
              }
              if (!this.onAgentEvent) return;
              try { this.onAgentEvent(fwd.type, fwd.data); } catch { /* the UI feed must never break the tool */ }
            },
            maxSteps: 6,
            deadlineMs: 120000,
          });
          if (lastShot) {
            const ls = lastShot as { data: string; mediaType: string; pageUrl?: string; app?: string; source: 'browser' | 'computer' };
            this.attachedImages.push({ mediaType: ls.mediaType, data: ls.data, source: ls.source, pageUrl: ls.pageUrl, app: ls.app, name: screenshotCaption(ls.source, ls) });
          }
          const text = (result.finalResponse || '').trim();
          logger.info(`ToolExecutor: browser_task done — driver=${result.driverUsed}, steps=${result.steps}, ${text.length} chars${lastShot ? ', screenshot attached' : ''}`);
          if (!text) return 'The browser agent finished without a result. Answer from the information you already have.';
          if (result.capabilityNotice) {
            logger.warn(`ToolExecutor: browser_task read-only session — ${result.capabilityNotice}`);
          }
          // The formatter owns the result surface (feedback c3c06260): a
          // capabilityNotice becomes a hard banner the calling model reads FIRST.
          return formatBrowserTaskToolResult(result);
        }

        case 'computer_task': {
          const task = String(args.task || '').trim();
          if (!task) return 'No task provided for computer use.';
          if (!this.userId) {
            return 'Computer use is only available for signed-in users (it drives THEIR paired Mac).';
          }
          logger.info(`ToolExecutor: computer_task("${task.substring(0, 100)}") user=${this.userId}`);
          // Dynamic import — same no-cycle pattern as browser_task above.
          const { runComputerAgentSession } = await import('./computer-agent');
          let lastScreen: { data: string; mediaType: string; app?: string } | null = null;
          const result = await runComputerAgentSession({
            userId: this.userId,
            chatId: null,
            message: task,
            // Multi-Mac (2026-09-24): drive a specific paired Mac when the
            // user has several and named one.
            ...(args.device ? { device: String(args.device) } : {}),
            // 8fe9429c: a read-only worker's cache marks its computer_task
            // observe-only — camera on the paired screen, every input action
            // refused at the computer-loop dispatch gate.
            ...(this.opts.computerInputMode === 'observe' ? { inputMode: 'observe' as const } : {}),
            // cu-diag fix #6: machine-run provenance (owner-presence gate) +
            // the holder label recorded next to the device use-lock.
            ...this.computerProvenance(),
            // Tool-delegated session: the calling model narrates (progress/chunk
            // stay private; ask_user surfaces in the returned text) — but the
            // per-action computer-observation frames forward up the calling
            // run's stream (2026-09-09) so the panel shows the Mac screen live.
            sendEvent: (t: string, d: any) => {
              const fwd = forwardableBrowserObservation(t, d);
              if (!fwd) return;
              const shot = screenshotFromFrame(fwd.data);
              if (shot) lastScreen = { ...shot, app: typeof fwd.data.app === 'string' ? fwd.data.app : undefined };
              if (!this.onAgentEvent) return;
              try { this.onAgentEvent(fwd.type, fwd.data); } catch { /* the UI feed must never break the tool */ }
            },
            // Desktop tasks take more steps than a bounded web read (open app →
            // find the thing → act → verify): 12 steps / 5 min.
            maxSteps: 12,
            deadlineMs: 300000,
          });
          if (lastScreen) {
            const ls = lastScreen as { data: string; mediaType: string; app?: string };
            this.attachedImages.push({ mediaType: ls.mediaType, data: ls.data, source: 'computer', app: ls.app, name: screenshotCaption('computer', ls) });
          }
          logger.info(`ToolExecutor: computer_task done — steps=${result.steps}, ${(result.finalResponse || '').length} chars${lastScreen ? ', screenshot attached' : ''}`);
          if (result.capabilityNotice) {
            logger.warn(`ToolExecutor: computer_task unavailable — ${result.capabilityNotice}`);
          }
          return formatComputerTaskToolResult(result);
        }

        case 'web_pipe': {
          // Legacy pipeline: no session RAG store → digest-only (sessionId null).
          const r = await runWebPipe(null, {
            query: args.query ? String(args.query) : undefined,
            urls: Array.isArray(args.urls) ? args.urls.map(String) : undefined,
            focus: args.focus ? String(args.focus) : undefined,
          });
          const srcLines = r.sources.map(x => `- ${x.title || x.url} (${x.url})${x.stored ? '' : ` — ${x.note || 'unreadable'}`}`).join('\n');
          return `${r.summary}\n\nSOURCES:\n${srcLines}`;
        }

        case 'youtube_pipe': {
          // Legacy pipeline: no session RAG store → digest-only (sessionId null).
          const r = await runYoutubePipe(null, {
            query: args.query ? String(args.query) : undefined,
            urls: Array.isArray(args.urls) ? args.urls.map(String) : undefined,
            focus: args.focus ? String(args.focus) : undefined,
            stt: typeof args.stt === 'boolean' ? args.stt : undefined,
          });
          const vidLines = r.videos.map(x => `- ${x.title || x.videoId} (${x.url})${x.method !== 'failed' ? ` — via ${x.method}` : ' — no transcript'}`).join('\n');
          return `${r.summary}\n\nVIDEOS:\n${vidLines}`;
        }

        // ── Document tools (GeneratedFile, per-user) ─────────────────────────

        case 'create_document': {
          if (!this.userId) return DOC_SIGN_IN_MSG;
          const filename = String(args.filename || '').trim();
          if (!filename) return 'create_document needs a `filename` (with extension, e.g. "report.xlsx").';
          const doc = await generateDocument({
            filename,
            format: args.format ? String(args.format) : undefined,
            content: args.content !== undefined && args.content !== null ? String(args.content) : undefined,
            sheets: normalizeSheets(args.sheets),
            title: args.title ? String(args.title) : undefined,
          });
          // M1: enforce the per-user storage quota BEFORE persisting.
          const createQuotaErr = await generatedFileQuotaError(this.userId, doc.buffer.length, { newRow: true });
          if (createQuotaErr) return createQuotaErr;
          const record = await createGeneratedFileRow({
            userId: this.userId,
            // Chat attribution (ticket 8db4c18e; tightened 2026-09-22 — owner:
            // "files from another project session are appearing in a different
            // project session's chat sidebar"): the RUN's chat always wins.
            // The model's optional `chatId` used to override it, so a lane or
            // supervisor that copied another chat's id (fleet digests are full
            // of them) filed its document under THAT chat, and the other
            // session's Files sidebar listed it. Now the arg is honored only
            // when the run has no chat of its own AND the id is one of the
            // user's own chats (verified) — otherwise the file stays with the
            // run's chat (or unattributed).
            chatId: await this.generatedFileChatId(args.chatId),
            filename,
            format: doc.format,
            mimeType: doc.mimeType,
            size: doc.buffer.length,
            data: doc.buffer.toString('base64'),
            textContent: doc.textContent,
          });
          logger.info(`ToolExecutor: create_document ${filename} (${doc.format}, ${doc.buffer.length} bytes) → file ${record.id} user=${this.userId}`);
          return `Created ${filename} (${doc.format}, ${doc.buffer.length} bytes). File id: ${record.id}. Saved to the user's Files page (/files) — tell them it's there.\nDownload link (render as-is): ${downloadPath(record.id)}`;
        }

        case 'read_document': {
          if (!this.userId) return DOC_SIGN_IN_MSG;
          // Paging params — apply-or-reject: an invalid offset/limit is a hard
          // error (never silently clamped), and validation runs BEFORE any
          // prisma read so a bad call costs nothing.
          const rawOffset = args.offset;
          if (rawOffset !== undefined && rawOffset !== null) {
            if (typeof rawOffset !== 'number' || !Number.isInteger(rawOffset) || rawOffset < 0) {
              return `read_document: invalid offset ${JSON.stringify(rawOffset)} — offset must be an integer >= 0 (0-based character offset into the stored text).`;
            }
          }
          const rawLimit = args.limit;
          if (rawLimit !== undefined && rawLimit !== null) {
            if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 50000) {
              return `read_document: invalid limit ${JSON.stringify(rawLimit)} — limit must be an integer between 1 and 50000.`;
            }
          }
          const offset = typeof rawOffset === 'number' ? rawOffset : 0;
          const limit = typeof rawLimit === 'number' ? rawLimit : 50000;
          // Header + paged body shared by both paths: states the FULL text's
          // total length + sha256, the requested slice, and (when more text
          // remains) how to page further.
          const paged = (header: string, fullText: string, emptyNote: string): string => {
            if (fullText.length === 0) return `${header}\n${emptyNote}`;
            if (offset >= fullText.length) {
              return `${header}\n(offset past end of text — total ${fullText.length} chars, nothing at offset ${offset})`;
            }
            const end = Math.min(offset + limit, fullText.length);
            let out = `${header}\n${fullText.slice(offset, end)}`;
            if (offset + limit < fullText.length) {
              out += `\n(showing chars ${offset}–${end} of ${fullText.length} — page with offset/limit)`;
            }
            return out;
          };
          const fileId = args.fileId ? String(args.fileId) : null;
          const documentId = args.documentId ? String(args.documentId) : null;
          if (!fileId && !documentId) {
            return 'read_document needs a `fileId` (generated file) or `documentId` (knowledge document) — call list_files to find ids.';
          }
          if (fileId) {
            const file = await prisma.generatedFile.findFirst({ where: { id: fileId, userId: this.userId } });
            if (!file) {
              return `No generated file with id ${fileId} belongs to this user. Call list_files to see the current files.`;
            }
            const fullText = file.textContent || '';
            const sha256 = createHash('sha256').update(fullText, 'utf8').digest('hex');
            let out = paged(
              `[File: ${file.filename} — ${file.format}, ${file.size} bytes | text: ${fullText.length} chars, sha256: ${sha256}]`,
              fullText,
              '(no text rendering stored for this file)',
            );
            if (fullText.length > 0 && !file.textContent?.trim()) out += '\n(no text rendering stored for this file)';
            // For PDFs with an AcroForm, surface the form field names so the
            // model can call fill_pdf_form with the CORRECT names.
            if (file.format === 'pdf') {
              try {
                const formFields = await listPdfFormFields(Buffer.from(file.data, 'base64'));
                if (formFields.length > 0) {
                  out += `\n\nPDF FORM FIELDS (use these exact names with fill_pdf_form):\n${formFields.map(f => `- ${f.name} (${f.type})`).join('\n')}`;
                }
              } catch { /* not a form PDF — skip */ }
            }
            return out;
          }
          // Ticket b62927fb: project documents are PROJECT resources — they ground
          // every chat in the project (RAG) and list_knowledge_documents shows them
          // to ANY project member (getProjectAccess), so read access follows PROJECT
          // access, not the uploader's userId. Authorizing on userId alone refused
          // a doc the same caller could list as READY whenever uploader ≠ reader
          // (shared project, or the same human under a second account).
          // Fetch by id, then authorize; the refusal text stays IDENTICAL for
          // "no such doc" and "no access" so existence is never leaked (the same
          // 404-for-both idiom as documents.controller.getDocumentStatus).
          const knowledgeDoc = await prisma.projectDocument.findFirst({ where: { id: documentId! } });
          if (!knowledgeDoc) {
            return `No knowledge document with id ${documentId} belongs to this user. Call list_files to see the current documents.`;
          }
          if (knowledgeDoc.userId !== this.userId) {
            // Dynamic import — the no-static-cycle pattern (platform.service
            // statically imports crossmodel.service; same as browser_task above).
            const { getProjectAccess } = await import('./platform/platform.service');
            const projectAccess = knowledgeDoc.projectId
              ? await getProjectAccess(knowledgeDoc.projectId, this.userId)
              : null;
            if (!projectAccess) {
              return `No knowledge document with id ${documentId} belongs to this user. Call list_files to see the current documents.`;
            }
          }
          // NO take cap: the stated total + sha256 must cover the true full
          // document text, so every chunk is fetched (content only).
          const chunks = await prisma.projectChunk.findMany({
            where: { documentId: knowledgeDoc.id },
            orderBy: { chunkIndex: 'asc' },
            select: { content: true },
          });
          const fullText = chunks.map(c => c.content).join('\n\n');
          const sha256 = createHash('sha256').update(fullText, 'utf8').digest('hex');
          return paged(
            `[Document: ${knowledgeDoc.name} | text: ${fullText.length} chars, sha256: ${sha256}]`,
            fullText,
            '(no extracted text — the document may still be processing)',
          );
        }

        case 'update_document': {
          if (!this.userId) return DOC_SIGN_IN_MSG;
          const fileId = String(args.fileId || '').trim();
          if (!fileId) return 'update_document needs a `fileId` — call list_files to find it.';
          const existing = await prisma.generatedFile.findFirst({ where: { id: fileId, userId: this.userId } });
          if (!existing) {
            return `No generated file with id ${fileId} belongs to this user. Call list_files to see the current files.`;
          }
          const doc = await generateDocument({
            filename: existing.filename,
            format: existing.format,
            content: args.content !== undefined && args.content !== null ? String(args.content) : undefined,
            sheets: normalizeSheets(args.sheets),
            title: args.title ? String(args.title) : undefined,
          });
          // M1: update replaces the row in place — byte cap only, net of the
          // bytes being replaced (the row count doesn't change).
          const updateQuotaErr = await generatedFileQuotaError(this.userId, doc.buffer.length, {
            newRow: false,
            replacesRawBytes: typeof existing.size === 'number' ? existing.size : 0,
          });
          if (updateQuotaErr) return updateQuotaErr;
          await prisma.generatedFile.update({
            where: { id: existing.id },
            data: {
              data: doc.buffer.toString('base64'),
              size: doc.buffer.length,
              textContent: doc.textContent,
            },
          });
          logger.info(`ToolExecutor: update_document ${existing.filename} (${doc.format}, ${doc.buffer.length} bytes) → file ${existing.id} user=${this.userId}`);
          return `Updated ${existing.filename} (${doc.format}, ${doc.buffer.length} bytes). File id: ${existing.id}. The change is live on the user's Files page (/files).\nDownload link (render as-is): ${downloadPath(existing.id)}`;
        }

        case 'list_files': {
          if (!this.userId) return DOC_SIGN_IN_MSG;
          const [generated, knowledgeDocs, chatUploads] = await Promise.all([
            prisma.generatedFile.findMany({
              where: { userId: this.userId },
              orderBy: { createdAt: 'desc' },
              take: 50,
              select: { id: true, filename: true, format: true, size: true, createdAt: true },
            }),
            prisma.projectDocument.findMany({
              where: { userId: this.userId },
              orderBy: { createdAt: 'desc' },
              take: 50,
              select: { id: true, name: true, mimeType: true, status: true, charCount: true },
            }),
            // This chat's persisted uploads (ChatFile, 2026-08-31): the agent's
            // first-class path to EMBED a user-uploaded image in its answer —
            // the /files/<id>/inline URL renders inline + click-to-zoom in chat
            // markdown. Scoped to the run's chat; empty for chat-less runs.
            this.chatId
              ? prisma.chatFile.findMany({
                  where: { chatId: this.chatId },
                  orderBy: { createdAt: 'desc' },
                  take: 50,
                  select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
                })
              : Promise.resolve([]),
          ]);
          if (generated.length === 0 && knowledgeDocs.length === 0 && chatUploads.length === 0) {
            return 'The user has no files yet — no generated files, no uploaded/knowledge documents, and no files uploaded in this chat.';
          }
          const genSection = generated.length > 0
            ? generated.map(f => `- ${f.filename} (${f.format}, ${f.size} bytes, ${fmtDate(f.createdAt)}) — File id: ${f.id}`).join('\n')
            : '(none yet — create_document makes them)';
          const docSection = knowledgeDocs.length > 0
            ? knowledgeDocs.map(d => `- ${d.name} (${d.mimeType}, ${d.status}, ${d.charCount} chars) — Document id: ${d.id}`).join('\n')
            : '(none yet)';
          const uploadSection = chatUploads.length > 0
            ? chatUploads.map((f) => {
                const inline = f.mimeType.toLowerCase().startsWith('image/')
                  ? ` — embed in your answer as: ![${f.filename}](/api/crossmodel/files/${f.id}/inline)`
                  : '';
                return `- ${f.filename} (${f.mimeType}, ${f.sizeBytes} bytes, ${fmtDate(f.createdAt)})${inline}`;
              }).join('\n')
            : '(none yet — files the user attaches to messages appear here)';
          return `GENERATED FILES (downloadable — use the File id with read_document / update_document / fill_pdf_form):\n${genSection}\n\nUPLOADED/KNOWLEDGE DOCUMENTS (use the Document id with read_document):\n${docSection}\n\nTHIS CHAT'S UPLOADS (images embed inline in your answer with the exact markdown shown):\n${uploadSection}`;
        }

        case 'fill_pdf_form': {
          if (!this.userId) return DOC_SIGN_IN_MSG;
          const rawFields = args.fields;
          if (!rawFields || typeof rawFields !== 'object' || Array.isArray(rawFields) || Object.keys(rawFields).length === 0) {
            return "fill_pdf_form needs `fields`: an object mapping the PDF's own form field names to values, e.g. { \"first_name\": \"Ada\" }.";
          }
          const fields: Record<string, string> = {};
          for (const [k, v] of Object.entries(rawFields)) {
            fields[String(k)] = v === null || v === undefined ? '' : String(v);
          }

          // ── Resolve the source PDF binary ──────────────────────────────────
          let template: Buffer;
          let sourceBase = 'form';
          const fileId = args.fileId ? String(args.fileId) : null;
          const uploadId = args.uploadId ? String(args.uploadId) : null;
          if (fileId) {
            const file = await prisma.generatedFile.findFirst({ where: { id: fileId, userId: this.userId } });
            if (!file) {
              return `No generated file with id ${fileId} belongs to this user. Call list_files to see the current files.`;
            }
            if (file.format !== 'pdf') {
              return `File ${file.filename} is a ${file.format}, not a PDF — fill_pdf_form only works on PDFs.`;
            }
            template = Buffer.from(file.data, 'base64');
            sourceBase = file.filename.replace(/\.pdf$/i, '');
          } else if (uploadId) {
            const rawUpload = await loadAttachment(uploadId);
            // M2: uploads are stamped with their uploader at stash time
            // (Attachment.ownerUserId). An upload owned by a DIFFERENT account
            // is treated exactly like a missing one — same message, no
            // existence leak. A null/absent owner (anonymous upload, or a blob
            // stashed before this field existed) stays loadable — unchanged
            // behavior, protected by the unguessable UUID + 15-min TTL.
            const upload = rawUpload && rawUpload.ownerUserId != null && rawUpload.ownerUserId !== this.userId
              ? null
              : rawUpload;
            if (upload?.type === 'pdf' && upload.base64) {
              template = Buffer.from(upload.base64, 'base64');
              sourceBase = upload.filename.replace(/\.pdf$/i, '');
            } else if (upload) {
              return `Upload ${uploadId} is a ${upload.type}, not a PDF — fill_pdf_form only works on PDF attachments.`;
            } else {
              return `Upload ${uploadId} expired or was not found — attachments live for ~15 minutes after upload. Ask the user to re-attach the PDF, then retry fill_pdf_form with the new uploadId.`;
            }
          } else {
            return "fill_pdf_form needs a source PDF: pass `fileId` (a generated PDF from list_files) or `uploadId` (from an attached PDF's context line).";
          }

          const { buffer, missing } = await fillPdfForm(template, fields);
          // M1: the filled copy is a NEW row — enforce the quota before persisting.
          const fillQuotaErr = await generatedFileQuotaError(this.userId, buffer.length, { newRow: true });
          if (fillQuotaErr) return fillQuotaErr;
          const filename = `${sourceBase}-filled.pdf`;
          const record = await createGeneratedFileRow({
            userId: this.userId,
            // Same chat-attribution default as create_document (ticket
            // 8db4c18e) — a filled form is a generated file too and must
            // surface in the chat's Files sidebar.
            chatId: this.chatId ?? null,
            filename,
            format: 'pdf',
            mimeType: 'application/pdf',
            size: buffer.length,
            data: buffer.toString('base64'),
            textContent: `Filled PDF form from ${sourceBase}. Fields set: ${Object.keys(fields).filter(k => !missing.includes(k)).join(', ') || '(none)'}.`,
          });
          logger.info(`ToolExecutor: fill_pdf_form ${sourceBase} → ${record.id} (${buffer.length} bytes, ${missing.length} missing) user=${this.userId}`);
          let out = `Filled PDF saved as ${filename} (pdf, ${buffer.length} bytes). File id: ${record.id}. Saved to the user's Files page (/files) — tell them it's there.\nDownload link (render as-is): ${downloadPath(record.id)}`;
          if (missing.length > 0) {
            out += `\n\nThese field names did NOT match the form and were NOT set: ${missing.join(', ')}.`;
            try {
              const actual = await listPdfFormFields(template);
              if (actual.length > 0) {
                out += `\nThe form's actual fields are:\n${actual.map(f => `- ${f.name} (${f.type})`).join('\n')}\nRetry fill_pdf_form with the exact field names.`;
              }
            } catch { /* field listing failed — the missing names are already reported */ }
          }
          return out;
        }

        // ── Image generation (Image generator seat; owner ask 2026-09-24) ────
        // MUTATING non-consequential (owner-scoped, reversible from the Files
        // page, bounded by the rate slots + the GeneratedFile quota): no
        // confirmation card, no autonomy grant. Dispatch order note: this case
        // runs via WEB_TOOL_NAMES BEFORE executeCodingTool's checkPermission —
        // the same posture as create_document; the caps are the gate.
        case 'generate_image': {
          if (!this.userId) return DOC_SIGN_IN_MSG;
          const userId = this.userId;
          const parsed = validateGenerateImageArgs(args);
          if (!parsed.ok) return parsed.message;
          const { prompt, aspect, style, polish, negativePrompt } = parsed.input;

          const ref = await resolveImageReference(userId, { referenceFileId: args.referenceFileId, referenceUploadId: args.referenceUploadId });
          if (!ref.ok) return ref.message;

          // Storage quota pre-flight BEFORE any slot or paid provider call
          // (review 2026-09-24): a full account used to pay for an image that
          // storeGeneratedImage then refused. The exact check there remains
          // the byte-accurate guard.
          const quotaPre = await preflightImageQuota(userId);
          if (quotaPre) return quotaPre;

          // Caps are consumed BEFORE the provider call and refunded on any
          // failure below, so failed attempts never eat the budget.
          const slots = await takeImageGenerationSlots(userId, this.chatId ?? `user-${userId}`);
          if (!slots.ok) {
            void recordImageGenerationMetric(this.chatId, 0, { surface: 'tool', ok: false, rateLimited: true, scope: slots.scope, cap: slots.cap, chatId: this.chatId ?? undefined });
            return slots.message;
          }

          logger.info(`ToolExecutor: generate_image("${prompt.substring(0, 80)}"${aspect ? `, ${aspect}` : ''}${ref.reference ? ', with reference' : ''}) user=${userId}`);
          const t0 = Date.now();
          let img: GeneratedImage;
          // 09a03aef: also pulls describeImageSubstitution — one helper in the
          // leaf keeps the tool result's substitution line and the leaf's own
          // surfaces from drifting apart.
          const { generateImage, describeImageSubstitution } = await import('./image-generate');
          try {
            img = await generateImage({ prompt, aspect, style, polish, negativePrompt, reference: ref.reference });
          } catch (err: any) {
            await slots.refund();
            const code = typeof err?.code === 'string' ? err.code : 'provider';
            const msg = scrubImageSecrets(String(err?.message || 'unknown error')).slice(0, 300);
            logger.warn(`ToolExecutor: generate_image failed (${code}) after ${Date.now() - t0}ms — ${msg}`);
            void recordImageGenerationMetric(this.chatId, Date.now() - t0, { surface: 'tool', ok: false, code, chatId: this.chatId ?? undefined });
            if (code === 'refused') {
              return `The image provider refused this prompt (content policy): ${msg}. Tell the user plainly; if appropriate offer a reworded prompt — do not retry the same prompt.`;
            }
            if (code === 'unconfigured') {
              return `Image generation is not configured on this Digby: ${msg}. Tell the user; do not retry this run.`;
            }
            if (code === 'timeout') {
              return `Image generation timed out (${msg}). You may retry ONCE with a simpler prompt (or without polish); otherwise tell the user.`;
            }
            return `Image generation failed: ${msg}. You may retry ONCE; if it fails again tell the user.`;
          }

          let stored: { id: string; filename: string };
          try {
            stored = await storeGeneratedImage(userId, await this.generatedFileChatId(args.chatId), img, { prompt, aspect, style });
          } catch (err: any) {
            await slots.refund();
            if (err?.code === 'quota') return String(err.message);
            throw err;
          }

          const mimeType = sniffGeneratedImageMime(img.bytes) ?? img.mimeType;
          this.attachedImages.push({
            mediaType: mimeType,
            data: img.bytes.toString('base64'),
            name: generatedImageCaption(img, prompt),
            source: 'generated',
            fileId: stored.id,
            prompt,
          });
          void recordImageGenerationMetric(this.chatId, img.latencyMs, {
            surface: 'tool', ok: true, model: img.model, provider: img.provider, spec: img.spec, aspect: aspect ?? 'square',
            referenceMode: img.referenceMode, editLegSource: img.editLegSource, bytes: img.bytes.length, chatId: this.chatId ?? undefined,
            // 09a03aef: the observable substitution signal (servingSpec != seat
            // spec) — keys present ONLY on a substituted serve.
            ...(img.substitutedFor ? { substitutedFor: img.substitutedFor, substitutionReason: img.substitutionReason } : {}),
          });
          const dims = img.width && img.height ? `${img.width}×${img.height} ` : '';
          const refNote = img.referenceMode === 'native'
            ? `; reference image used natively${img.editLegSource === 'fallback' ? ' (on a same-key edit-capable fallback leg, not the seated model)' : ''}`
            : img.referenceMode === 'described'
              ? '; the reference image was DESCRIBED by the Image reader seat and folded into the prompt (this model takes text only)'
              : '';
          // 09a03aef: never a silent swap — if the serving model is not the
          // seated model, the tool result says so in one line the agent relays.
          const subNote = img.substitutedFor ? `; NOTE: ${describeImageSubstitution(img)}. If the user asked for the seated model (${img.substitutedFor}), tell them the switch happened and that raising the endpoint model's imageTimeoutMs (Account → Admin → Endpoints) or IMAGE_CUSTOM_TIMEOUT_MS lets slow backends finish` : '';
          logger.info(`ToolExecutor: generate_image done — ${stored.filename} (${dims}${mimeType}, ${img.bytes.length} bytes; ${img.model} via ${img.provider}, ${img.latencyMs}ms${img.substitutedFor ? `, SUBSTITUTED for ${img.substitutedFor} (${img.substitutionReason})` : ''}) user=${userId}`);
          return `Generated ${stored.filename} (${dims}${mimeType}, ${img.bytes.length} bytes; ${img.model} via ${img.provider}, ${(img.latencyMs / 1000).toFixed(1)}s${refNote}${subNote}). File id: ${stored.id}. The image is ALREADY displayed in the chat under this tool call with a Download button and is saved on the user's Files page (/files) — do not embed it again (no markdown image, no base64, no URL); describe it briefly and offer one revision.`;
        }

        case 'scrape_batch': {
          // Review N6: the cap used to run BEFORE the pre-flight, so five junk
          // URLs consumed the whole budget and a valid sixth was never fetched
          // — or even mentioned. Pre-flight FIRST, then cap what is actually
          // dispatched, so a bad member can never displace a good one.
          const sentUrls = Array.isArray(args.urls)
            ? args.urls.map((u: unknown) => String(u ?? '').trim())
            : [];
          logger.info(`ToolExecutor: scrape_batch(${sentUrls.length} URLs)`);
          if (sentUrls.length === 0) return 'No URLs provided.';
          // Ticket 169d5080: BS-1 D5 wired the URL pre-flight into
          // scrape_as_markdown but NOT into this sibling, so ONE cut-off URL in a
          // batch still reached the gateway verbatim and came back as a raw
          // `400 ... "url" must be a valid uri` — the exact class the ticket is
          // about.
          //
          // THREE-WAY split, because rule 2 ("last query param has no `=`") cannot
          // tell a truncation (`?acti` cut out of `active_status`) from a COMPLETE
          // bare-flag URL (`?amp`, `?print`, `?autoplay`) — the two are lexically
          // identical. Refusing on rule 2 alone silently drops a page the model
          // asked for AND tells it, falsely, that its link was cut off; putting an
          // ambiguous member in the shared array lets one bad URL 400 the whole
          // call. So the ambiguous ones are dispatched ONE AT A TIME: a false
          // positive then costs only itself, and a real truncation fails alone
          // instead of poisoning the batch. Rules 1/3/4 (dangling ?/&, half a
          // percent-escape, no scheme, inner space) can never be a real URL and are
          // refused outright in both paths.
          const clean: Array<{ url: string }> = [];
          const ambiguous: Array<{ url: string }> = [];
          const refused: Array<{ url: string; reason: string }> = [];
          for (const candidate of sentUrls) {
            const strict = preflightUrl(candidate);
            if (strict.ok) { clean.push({ url: candidate }); continue; }
            // Still unusable with ONLY rule 2 relaxed ⇒ rule 2 was not the reason.
            if (preflightUrl(candidate, { allowBareTrailingKey: true }).ok) {
              ambiguous.push({ url: candidate });
              continue;
            }
            refused.push({ url: candidate, reason: strict.reason || 'incomplete URL' });
          }
          if (refused.length) {
            logger.info(`ToolExecutor: scrape_batch refused ${refused.length}/${sentUrls.length} URL(s) at pre-flight`);
          }
          const parts: string[] = [];
          // The unambiguous majority rides ONE call — the normal path, unchanged.
          // The 5-URL cap applies to what is DISPATCHED, not to what was sent.
          if (clean.length) {
            const r = await callMcpTool('scrape_batch', { urls: clean.slice(0, 5).map((c) => c.url) });
            parts.push(r || webNullResultMsg(`Failed to fetch the URLs — pages may be unavailable, blocked, or rate-limited (a transient 403/429 often clears after a cooldown). A retry after a short wait, or trying a different official source for the same content, is fine — just don't hammer the same URLs repeatedly. If they keep failing, answer from the search results you already have.`));
          }
          // Ambiguous members are isolated so one cannot take down the rest.
          for (const a of ambiguous.slice(0, 5)) {
            let r: string | null = null;
            try {
              r = await callMcpTool('scrape_batch', { urls: [a.url] });
            } catch {
              r = null; // a dispatch failure is this member's alone
            }
            parts.push(r || `[could not fetch] ${a.url} — this link may have been cut off, or the page may be unavailable. If it came from a snippet, re-send the whole URL.`);
          }
          if (refused.length) {
            parts.push(`[not fetched] ${refused.length} URL(s) were refused at pre-flight — re-send them in full:\n`
              + refused.map((r) => `- ${r.reason}`).join('\n'));
          }
          return parts.join('\n\n');
        }

        default:
          logger.warn(`ToolExecutor: unknown tool "${toolName}"`);
          return `Unknown tool: ${toolName}`;
      }
    } catch (error: any) {
      // Ticket e4d345a9: an unresolvable file OWNER is not a model-fixable
      // argument problem, so it must not be answered with the document-tool
      // "correct the arguments and retry" wording — the model cannot fix it and
      // the retry is what derailed the run. One sentence it relays, no retry,
      // and a warn (not error) in app_error_logs for the signature.
      if (error?.code === 'owner_unresolved' || error instanceof GeneratedFileOwnerError) {
        logger.warn(`ToolExecutor: ${toolName} refused (generated_file_owner_unresolved) user=${this.userId}`);
        return String(error?.message || GENERATED_FILE_OWNER_MSG);
      }
      logger.error(`ToolExecutor: ${toolName} failed: ${error.message}`);
      // Document-tool failures are usually model-fixable input problems (bad
      // sheets shape, invalid JSON, oversize content) — invite a corrected
      // retry instead of telling the model to abandon the user's document.
      if (DOC_TOOL_NAMES.has(toolName)) {
        return `Tool call failed: ${error.message} — correct the arguments and retry (call list_files if you need current file ids).`;
      }
      return `Tool call failed: ${error.message}. DO NOT retry this tool. Use the information you already have to answer the user's question directly.`;
    }
  }

  getStats(): { hits: number; misses: number; cacheSize: number } {
    return { hits: this.hits, misses: this.misses, cacheSize: this.cache.size };
  }
}

// ── Agentic Tool-Calling Loop ──────────────────────────────────────────────────

interface ToolCallMessage {
  role: 'assistant';
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface ToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

/**
 * Process tool calls from a model response.
 * Executes each tool call via the cached executor and returns
 * the messages to append to the conversation for the next model call.
 *
 * Returns [assistantMessage, ...toolResultMessages] ready to append to messages array.
 */
export async function processToolCalls(
  assistantMessage: ToolCallMessage,
  cache: ToolCache
): Promise<Array<ToolCallMessage | ToolResultMessage>> {
  const results: Array<ToolCallMessage | ToolResultMessage> = [assistantMessage];

  for (const toolCall of assistantMessage.tool_calls) {
    // Ticket c42e8099 (2026-10-30) — THE FABRICATED-ARGS HOLE. This seam used
    // to `catch { args = {} }`, which is exactly what the 2026-08-30 harness
    // audit outlawed: a TRUNCATED payload must never execute with fabricated or
    // empty arguments. `tool-arguments.ts` documents that invariant at the
    // STREAMING seam (agent.ts runTool) and enforces it there; this
    // non-streaming agentic loop is the parallel path for the same class of
    // call, so it silently broke it — a severed `{}`-shaped payload executed a
    // zero-arg MUTATING tool whose narration described args that never arrived,
    // and the model saw a SUCCESS receipt for work nobody asked for.
    //
    // Measured context for this ticket: the reporter's five cuts were all
    // REJECTED at the streaming seam (telemetry `tool_call_finalize`, seam
    // dispatch_reject, shape=truncated), so refusal-with-no-execution already
    // worked there. The gap was never "detect truncation" — it was that a
    // SECOND path into execution had no detector at all.
    //
    // One seam, one parser: parseToolArguments does the lossless repair
    // (unescaped control chars, an object-valued arguments fragment) and
    // classifies the failure, and toolArgumentRejection reuses the per-class
    // wording the streaming path already ships ("nothing was executed" +
    // re-emit for a truncated payload, syntax fix for a malformed one). A
    // rejected call answers the model instead of running the tool, so the
    // no-partial-apply guarantee now holds on both paths.
    let result: string;
    const parsedArgs = parseToolArguments(toolCall.function.arguments);
    if (!parsedArgs.ok) {
      result = toolArgumentRejection(toolCall.function.name, parsedArgs);
      try {
        // Ticket c42e8099 ask (2) — COUNT IT PER CHAT. The streaming seam has
        // carried a `tool_call_finalize`/`seam:'dispatch_reject'` row for every
        // refusal since 5bdbb126, which is how this ticket's five cuts were
        // MEASURED at all. This seam had no row, so a lane degrading here was
        // invisible on telemetry — the exact blind spot the report describes.
        // Same kind, distinct `seam` value: one query answers "is a lane's
        // transport degrading" regardless of which loop it entered through.
        // Short keys (sh/tl/al/cid/why) sort ahead of the 240-char meta read
        // cut, the established reason agent.ts's dispatch_reject meta leads
        // with `shape`.
        const chatScope = cache.chatScopeId();
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.TOOL_CALL_FINALIZE,
          ...(chatScope ? { sessionId: chatScope } : {}),
          meta: {
            sh: parsedArgs.shape,
            seam: 'nonstream_reject',
            tool: toolCall.function.name,
            al: parsedArgs.argLen,
            cid: toolCall.id,
            why: parsedArgs.reason,
          },
        });
      } catch { /* telemetry never breaks a tool call */ }
      try {
        logger.warn(
          `tool-executor: refused ${toolCall.function.name} — arguments did not parse ` +
          `(shape=${parsedArgs.shape}, argLen=${parsedArgs.argLen}, reason=${parsedArgs.reason}); NOTHING was executed`,
        );
      } catch { /* telemetry never breaks a tool call */ }
    } else {
      result = await cache.getOrExecute(toolCall.function.name, parsedArgs.args);
    }

    results.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: result,
    });
  }

  return results;
}
