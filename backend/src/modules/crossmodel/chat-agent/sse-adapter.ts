/**
 * One-Digby Phase 2 (step 5): agent-events → legacy chat SSE adapter.
 *
 * The chat UI speaks the legacy protocol (init/progress/model-response/chunk/
 * thinking-summary/canvas/followups/complete/error). This adapter translates a
 * live agent run into it, solving the C3 streaming problem with a HOLDBACK:
 *
 *   - Text deltas buffer per "turn segment" (a run of text between tool events).
 *   - A segment that reaches HOLDBACK_CHARS with no tool call is treated as the
 *     answer and streams live from that point (narration is short; real answers
 *     blow through the holdback within ~1s).
 *   - FIRST-WORD OPENER (ticket 4f7263e4, 2026-10-11): the attempt's FIRST
 *     pre-tool segment is the opener line the chat doctrine asks for (one honest
 *     sentence before the first tool call — the ttft audit showed the first word
 *     otherwise waiting for the lead's whole web-tool loop, web_pipe 73–161 s).
 *     It is DELIVERED as the answer's opening chunk, never dropped; the doctrine's
 *     "Do not narrate" line keeps governing everything after the first tool call
 *     (later pre-tool segments are still dropped / demoted per the 2026-10-04
 *     status-voice polish). Kill switch FIRST_WORD_OPENER_DISABLED=1 removes the
 *     doctrine note (chat-agent/first-word-note.ts) — the adapter still delivers
 *     a first segment a model opens on its own.
 *   - A tool call arriving while still under holdback reclassifies any LATER
 *     buffered text as inter-tool narration → dropped (demoted to a `progress`
 *     line under CHAT_STATUS_FILTER_DISABLED=1), never leaked into the answer
 *     (kills the "Let me check…" leak).
 *   - On run end, any still-buffered text flushes as answer (short final answers
 *     like "42." survive).
 *
 * Double Checker workers surface as legacy model-response cards on subagent_end.
 * Pure state machine — no I/O — unit-testable.
 */

import { hideReasoningDisabled } from '../coding/reasoning-wire';
import { STATUS, chatStatusFilterDisabled, chatStatusForAgentProgress } from './status-voice';

export type LegacySend = (type: string, data: any) => void;

const HOLDBACK_CHARS = 300;
const THINKING_THROTTLE_MS = 1500;
// The doctrine puts the [FOLLOWUPS] block at the very END of the answer. It is
// parsed out at finalize (and sent as a `followups` event), so the live stream
// must suppress it — a 12-char lookahead tail catches the marker even when it
// is split across deltas, at the cost of an imperceptible streaming delay.
const FOLLOWUPS_MARKER = '[FOLLOWUPS';
const LOOKAHEAD = FOLLOWUPS_MARKER.length + 2;
// Case-insensitive matcher for the same marker (ticket 0d344f95): synthesis
// models don't always honor the doctrine's exact uppercase — a '[Followups]'
// variant slipped past the case-sensitive indexOf suppression, streamed the
// raw block to the user as literal bracketed text, and then missed the
// case-sensitive parseFollowUps extraction too (no chips), while the
// frontend's /gi strip silently cleaned the persisted copy. Both indexOf
// call sites now search() this regex instead.
const FOLLOWUPS_MARKER_RE = /\[followups/i;

/** Map a coding-model id to the legacy model card key the chat UI knows. */
export function modelCardKey(model: string): string {
  if (model.startsWith('deepseek')) return 'deepseek';
  if (model.startsWith('kimi')) return 'kimi';
  if (model.startsWith('glm')) return 'glm';
  // L4 frontier consultants report their real model IDs (e.g. gemini-3.1-pro-preview)
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('gpt') || model.startsWith('openai') || model === 'chatgpt') return 'openai';
  if (model.startsWith('grok')) return 'grok';
  return model;
}

/** A destination is only trusted when it is itself an absolute http(s) URL. */
function httpDest(dest: string | null): string | null {
  return dest && /^https?:\/\//i.test(dest) ? dest : null;
}

/** Unwrap well-known search redirect wrappers so the Sources UI shows the real
 *  destination instead of the redirector host (feedback a2063c30 — a row of
 *  "www.google.com" cards in one answer; audit p10 widened it beyond
 *  google.com/www.google.com). Covered:
 *    - Google SERP redirects on ANY regional domain (google.com, google.co.uk,
 *      google.de, …): /url with the destination in ?q= or ?url=
 *    - Bing click-tracking: bing.com/ck/… with ?u= (plain URL, or Bing's
 *      'a1'-prefixed base64url encoding — decoded only when that shape is
 *      actually present)
 *    - DuckDuckGo: duckduckgo.com/l/ with ?uddg=
 *    - Vertex AI Search grounding redirects (vertexaisearch.cloud.google.com):
 *      unwrapped only when a destination param is present — the usual
 *      /grounding-api-redirect/<token> form is an OPAQUE server-side redirect
 *      that cannot be resolved without a network fetch, so it passes through.
 *  Anything not confidently unwrappable returns the original URL verbatim. */
export function unwrapRedirectUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();

    // Google SERP — any regional TLD (google.com, google.co.uk, google.com.au, …).
    if (/^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host) && u.pathname === '/url') {
      return httpDest(u.searchParams.get('q')) ?? httpDest(u.searchParams.get('url')) ?? raw;
    }

    // Bing click-tracking: /ck/a?…&u=a1<base64url> (or occasionally a plain URL).
    if (/^(www\.)?bing\.com$/.test(host) && u.pathname.startsWith('/ck/')) {
      const enc = u.searchParams.get('u');
      if (!enc) return raw;
      const plain = httpDest(enc);
      if (plain) return plain;
      // Base64 handling ONLY when Bing's encoded shape is present: an 'a1'
      // marker followed by base64url. Any decode doubt → original URL.
      if (/^a1[A-Za-z0-9_-]+={0,2}$/.test(enc)) {
        try {
          const b64 = enc.slice(2).replace(/-/g, '+').replace(/_/g, '/');
          const decoded = Buffer.from(b64, 'base64').toString('utf8');
          const dest = httpDest(decoded);
          if (dest) return dest;
        } catch { /* fall through to raw */ }
      }
      return raw;
    }

    // DuckDuckGo: /l/?uddg=<percent-encoded destination> (searchParams decodes).
    if (/^(www\.)?duckduckgo\.com$/.test(host) && u.pathname.startsWith('/l/')) {
      return httpDest(u.searchParams.get('uddg')) ?? raw;
    }

    // Vertex grounding redirects: destination param when present; the opaque
    // /grounding-api-redirect/<token> form has nothing to unwrap locally.
    if (host === 'vertexaisearch.cloud.google.com') {
      return httpDest(u.searchParams.get('url')) ?? httpDest(u.searchParams.get('q')) ?? raw;
    }

    return raw;
  } catch {
    return raw; // not a parseable URL — keep verbatim
  }
}

/** True for URLs that can never be a real citation in the Sources row: bare
 *  search-engine hosts (SERP links, block/consent pages, unresolvable
 *  redirects) and the search vendor's doc host, which leaks out of tool
 *  error text (owner report 2026-08-15 — six "www.google.com" pills plus a
 *  "docs.brightdata.com" pill in one answer). Subdomains with real content
 *  (support.google.com, developers.google.com, blog.google) are KEPT. */
export function isNonCitationHost(raw: string): boolean {
  let host: string;
  try { host = new URL(raw).hostname.toLowerCase(); } catch { return false; }
  if (/^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(host)) return true;
  if (/^(www\.)?(bing|duckduckgo)\.com$/.test(host)) return true;
  if (host === 'search.yahoo.com') return true;
  if (host === 'vertexaisearch.cloud.google.com') return true;
  if (host === 'docs.brightdata.com') return true;
  return false;
}

/** One-line tool description for the live activity feed (coding-UI style). */
export function toolDetail(name: string, args: any): string {
  if (!args) return name;
  if (args.query) return String(args.query).slice(0, 80);
  if (args.url) return String(args.url).slice(0, 80);
  if (Array.isArray(args.urls)) return `${args.urls.length} pages`;
  if (args.task) return String(args.task).slice(0, 80);
  return '';
}

/** Bare search-host SERP URLs are dropped by isNonCitationHost; a GitHub
 *  CODE-SEARCH result is a LISTING, not a document (ticket 659b5074) — the
 *  github-mcp wrapper opens both the auto-scoped and the explicit-scope form
 *  with this exact marker, so it is the reliable shape test. */
const GITHUB_CODE_SEARCH_LISTING_RE = /^\[GitHub Code Search[ —]/;

/** Kill switch for the listing gate (ticket 659b5074): =1 restores the pre-fix
 *  harvest of URLs from github_search_code listings into the Sources chips. */
export function githubListingSourcesDisabled(): boolean {
  return process.env.GITHUB_LISTING_SOURCES_DISABLED === '1';
}

/** Tools whose result is RECALL OF OUR OWN STORED MATERIAL — never a page this
 *  run fetched off the web, so a URL inside one is provenance of the stored
 *  object and never a citation for THIS answer (tickets 23e80d1e +
 *  659b5074's class, one level out).
 *
 *  THE DISCRIMINATOR IS PROVENANCE, NOT SHAPE: a citation chip means "a page
 *  this answer read". `github_get_file_contents` stays harvestable because it
 *  FETCHES the document from GitHub for this run; everything below merely
 *  reads back something already in our store (memory hits, prior chat text,
 *  canvases, knowledge documents, worktree files, the feedback inbox). The
 *  reported occurrence was a stored `youtube_pipe` finding whose provenance
 *  URL surfaced through `search_memory` and rendered as "a youtube source for
 *  some random game" under an unrelated answer. */
const STORED_MATERIAL_TOOLS = new Set([
  // relevance-matched retrieval over our own store
  'search_memory', 'list_memory', 'search_chats',
  // deliberate reads of one stored object (chat text / canvas / document / file / inbox)
  'get_chat_messages', 'get_supervisor_state', 'get_feedback',
  'get_canvas', 'list_canvases', 'read_document', 'list_knowledge_documents',
  'read_session_file', 'list_session_files',
]);

/** Kill switch for the stored-material gate (ticket 23e80d1e): =1 restores the
 *  pre-fix harvest of URLs out of recall / stored-object reads. */
export function storedMaterialSourcesDisabled(): boolean {
  return process.env.STORED_MATERIAL_SOURCES_DISABLED === '1';
}

/** Bare host for status lines ('https://www.example.com/x?y' → 'example.com'). */
export function hostOf(url: any): string {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Status/thinking lines speak in SEAT personas, never vendor model names
 * (owner directive 2026-07-14; seat names owner 2026-09-15: "Digby" the lead,
 * "Double Checker", "Triple Checker"). The chat agent passes the seat's
 * persona EXPLICITLY on every subagent event (the seat map is resolved per
 * run — any model can occupy any seat); this vendor-keyed map is only the
 * fallback for events that arrive without one, and mirrors the DEFAULT
 * lineup (kimi lead / deepseek Double Checker / glm Triple Checker). Model
 * identity stays visible in the More-info cards (the multi-model transparency
 * panel) — just not in the live narration.
 */
export function personaFor(model: string): string {
  if (model.startsWith('deepseek')) return 'Double Checker';
  if (model.startsWith('kimi')) return 'Digby';
  if (model.startsWith('glm')) return 'Triple Checker';
  if (model.startsWith('qwen')) return 'Helper';
  // L4 frontier consultants — the one place vendor identity IS the persona
  if (model.startsWith('gemini')) return 'Gemini consult';
  if (model.startsWith('gpt') || model.startsWith('openai') || model === 'chatgpt') return 'ChatGPT consult';
  if (model.startsWith('grok')) return 'Grok consult';
  return 'Assistant';
}

export class ChatAgentSSEAdapter {
  private segment = '';           // current text segment (under holdback)
  private streaming = false;      // current segment crossed holdback → live
  private answer = '';            // total text forwarded as answer chunks
  // Answer text EXCLUDING delivered opener segments (review F1, ticket 4f7263e4):
  // the emptiness gates (empty-retry / owner-turn replay / seat fallback in
  // chat-agent.service) must not mistake a delivered opener ("I'll check X now")
  // for answer content — pre-opener, a human turn that finalized empty after
  // tool calls counted as empty and recovered; counting the opener would blind
  // all three gates. Every append site writes BOTH accumulators except the
  // opener delivery, which writes only `answer` (the opener IS user-visible
  // answer text — refresh-safe — just not gate-relevant content).
  private answerSansOpener = '';
  private held = '';              // lookahead tail withheld while streaming live
  private suppressed = false;     // saw [FOLLOWUPS — everything after is cut
  private lastThinking = 0;
  private sources = new Set<string>();
  private searchCount = 0;
  private lastProgress = '';      // last status line sent (de-dupes repeated beats)
  // FIRST-WORD OPENER (ticket 4f7263e4): the attempt's first pre-tool segment is
  // the doctrine's opener line — delivered as the answer's opening chunk on the
  // first tool call, never dropped. Only ONE segment: later pre-tool segments
  // stay narration (dropped / demoted per the 2026-10-04 status-voice polish).
  private deliveredOpener = false;

  constructor(private send: LegacySend, private opts: { deliverOpener?: boolean } = {}) {}

  /** Total answer text forwarded (post-holdback), for finalization. */
  get answerText(): string { return this.answer; }
  /** Same text minus every delivered opener segment (review F1): what the
   *  emptiness gates read, so a one-line opener never masks an empty run.
   *  Cross-attempt safe: a retry/fallback attempt's opener is excluded too. */
  get answerTextWithoutOpener(): string { return this.answerSansOpener; }

  /** Append answer text and forward it as a live chunk. Writes BOTH
   *  accumulators — the opener delivery is the ONE exception (F1): it appends
   *  to `answer` only, so the opener never counts as gate-relevant content. */
  private appendAnswer(text: string): void {
    this.answer += text;
    this.answerSansOpener += text;
    this.send('chunk', { content: text });
  }
  get collectedSources(): string[] { return [...this.sources]; }
  get webSearchUsed(): boolean { return this.searchCount > 0; }

  handle(type: string, data: any): void {
    switch (type) {
      case 'text': this.onText(String(data?.delta ?? '')); return;
      case 'reasoning':
        // Thinking stays on the server (owner 2026-10-04, coding/reasoning-wire.ts): no raw deltas, no
        // "Digby: <reasoning>" summary — one plain status line says Digby is thinking. HIDE_REASONING_DISABLED=1
        // restores the live mirror (owner directive 2026-07-14 — real-time thinking).
        if (!hideReasoningDisabled()) {
          if (data?.delta && !this.streaming && !this.lastProgress) this.progress(STATUS.thinking, 'agent');
          return;
        }
        this.send('agent-activity', { kind: 'reasoning', label: 'Digby', delta: String(data?.delta ?? '') });
        this.onReasoning(String(data?.delta ?? ''));
        return;
      case 'tool_call':
        this.send('agent-activity', { kind: 'tool', label: 'Digby', name: String(data?.name ?? ''), detail: toolDetail(String(data?.name ?? ''), data?.args) });
        this.onToolCall(String(data?.name ?? ''), data?.args);
        return;
      case 'tool_result':
        // label (owner 2026-09-15): the lead's results carry the seat too, so
        // the client pairs call↔result per seat when the Double Checker's
        // calls interleave with Digby's on the same stream.
        this.send('agent-activity', { kind: 'tool_done', label: 'Digby', name: String(data?.name ?? ''), size: typeof data?.result === 'string' ? data.result.length : 0 });
        this.onToolResult(String(data?.name ?? ''), data?.result);
        // The pause after a result used to show the thinking stream; with thinking hidden, say what Digby is doing.
        if (!hideReasoningDisabled() && !this.streaming) this.progress(STATUS.tool.afterResult(String(data?.name ?? '')), 'agent');
        return;
      case 'subagent_start':
        this.send('progress', { message: `${String(data?.persona || personaFor(String(data?.model || '')))} is on it…`, stage: 'query' });
        return;
      case 'subagent_end':
        this.send('agent-activity', { kind: 'sub_end', label: String(data?.persona || personaFor(String(data?.model || ''))), time: Number(data?.time ?? 0) });
        this.onSubagentEnd(data);
        return;
      case 'progress': {
        // The agent loop's own lines are written for operators (seat fallbacks, HTTP codes, context sizes): on a
        // chat run each stage maps to a plain line or is dropped (status-voice.ts). CHAT_STATUS_FILTER_DISABLED=1
        // passes them through verbatim as before.
        const stage = String(data?.stage ?? 'agent');
        if (chatStatusFilterDisabled()) { this.send('progress', { message: String(data?.message ?? ''), stage }); return; }
        const line = chatStatusForAgentProgress(stage, data?.message);
        if (line) this.progress(line, stage);
        return;
      }
      // Confirmation UX (ask_user): the run is parked on a human reply. Forward
      // as hyphenated legacy events so the chat UI can render the question card;
      // the answer round-trips via POST /chats/:chatId/questions/:questionId.
      case 'ask_user':
        this.send('ask-user', {
          questionId: String(data?.questionId ?? ''),
          question: String(data?.question ?? ''),
          options: Array.isArray(data?.options) ? data.options.map((o: any) => String(o)) : [],
          // Soft answer deadline — the card renders a countdown and auto-expires
          // from it; absent on older emitters (clients fall back gracefully).
          ...(Number.isFinite(Number(data?.expiresAt)) && Number(data?.expiresAt) > 0 ? { expiresAt: Number(data?.expiresAt) } : {}),
          // Per-option one-line descriptions + multi-pick (clarify / creative-direction asks, 2026-10-20) — absent on
          // a plain labels-only question, so older clients see exactly the old payload.
          ...(Array.isArray(data?.optionDetails) && data.optionDetails.length
            ? { optionDetails: data.optionDetails.map((d: any) => ({ label: String(d?.label ?? ''), ...(d?.description ? { description: String(d.description) } : {}) })) }
            : {}),
          ...(data?.multiSelect === true ? { multiSelect: true } : {}),
        });
        return;
      case 'ask_user_resolved':
        this.send('ask-user-resolved', { questionId: String(data?.questionId ?? ''), answered: data?.answered === true });
        return;
      // UI Phase 6a (browser program): browser_task's per-action transparency
      // events (forwarded by ToolCache from the sub-session) ride the legacy
      // chat stream under the SAME event name the legacy mode='browser_agent'
      // full-session path already emits — one wire shape for browser activity;
      // the frontend normalizer (plain-session.ts) maps it back to the coding
      // vocabulary. Verbatim payload: {action, ok, url, driver, preview,
      // reasoning} / {action:'screenshot', ok, url, driver, screenshotBase64}.
      case 'browser_observation': this.send('browser-observation', data); return;
      // Screenshots in the chat (2026-09-23): the final browser/computer frame
      // as an inline image part — same payload shape as the coding stream.
      case 'image': this.send('image', data); return;
      case 'context': return;                 // sidebar meter — no legacy equivalent
      case 'error': this.send('error', { message: String(data?.message ?? 'Agent error') }); return;
      default: return;                        // unknown/coding-only events are dropped
    }
  }

  private onText(delta: string): void {
    if (!delta || this.suppressed) return;
    if (this.streaming) {
      this.forwardLive(delta);
      return;
    }
    this.segment += delta;
    const idx = this.segment.search(FOLLOWUPS_MARKER_RE);
    if (idx !== -1) {
      // The whole visible answer arrived under holdback; cut at the marker.
      this.suppressed = true;
      const visible = this.segment.slice(0, idx).trimEnd();
      this.segment = '';
      if (visible) { this.appendAnswer(visible); }
      return;
    }
    if (this.segment.length >= HOLDBACK_CHARS) {
      // Crossed the holdback with no tool call — this is the answer. Flush + go
      // live, keeping a lookahead tail so a split marker can still be caught.
      // F3 (review of ticket 4f7263e4): latch deliveredOpener here too — a ≥300
      // -char first segment IS live answer text, so without the latch the NEXT
      // short pre-tool segment would deliver as a second "opener" after the tool
      // call reset, leaking narration the "one segment" contract drops.
      this.streaming = true;
      this.deliveredOpener = true;
      const flush = this.segment;
      this.segment = '';
      this.forwardLive(flush);
    }
  }

  /** Live path: forward text minus a small withheld tail; cut at [FOLLOWUPS. */
  private forwardLive(delta: string): void {
    const buf = this.held + delta;
    const idx = buf.search(FOLLOWUPS_MARKER_RE);
    if (idx !== -1) {
      this.suppressed = true;
      this.held = '';
      const visible = buf.slice(0, idx).trimEnd();
      if (visible) { this.appendAnswer(visible); }
      return;
    }
    if (buf.length <= LOOKAHEAD) { this.held = buf; return; }
    const forward = buf.slice(0, buf.length - LOOKAHEAD);
    this.held = buf.slice(buf.length - LOOKAHEAD);
    this.appendAnswer(forward);
  }

  private onReasoning(delta: string): void {
    if (!delta) return;
    const now = Date.now();
    if (now - this.lastThinking < THINKING_THROTTLE_MS) return;
    this.lastThinking = now;
    const line = delta.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (line) this.send('thinking-summary', { summary: `Digby: ${line}` });
  }

  /** Send a status line unless it repeats the previous one verbatim. */
  private progress(message: string, stage: string): void {
    if (!message || message === this.lastProgress) return;
    this.lastProgress = message;
    this.send('progress', { message, stage });
  }

  private onToolCall(name: string, args: any): void {
    // FIRST-WORD OPENER (ticket 4f7263e4, 2026-10-11): the attempt's FIRST
    // pre-tool segment is the doctrine's opener line ("Open with one useful
    // line" — chat-agent/first-word-note.ts) — deliver it as the answer's
    // opening chunk. ONE segment only: it answers "is Digby alive" the moment
    // the (slow) web loop starts; the doctrine's "Do not narrate" line keeps
    // governing everything after the first tool call, so later pre-tool
    // segments are still dropped / demoted (the 2026-10-04 status-voice polish
    // below — CHAT_STATUS_FILTER_DISABLED=1 restores that demotion).
    if (this.opts.deliverOpener !== false && !this.deliveredOpener && !this.streaming && this.segment.trim() && !this.suppressed) {
      this.deliveredOpener = true;
      const opener = this.segment;
      this.segment = '';
      this.answer += opener;
      // F1 (review of ticket 4f7263e4): the opener is user-visible answer text
      // (refresh-safe) but is NOT gate-relevant content — answerSansOpener stays
      // untouched so the emptiness gates still see an empty run.
      this.send('chunk', { content: opener });
    }
    // Buffered pre-tool text is narration, not answer. It used to be demoted to a progress line; the tool line
    // below already says what Digby is doing, in Digby's voice, so the model's own prose is dropped (2026-10-04,
    // status-voice.ts). CHAT_STATUS_FILTER_DISABLED=1 restores the demotion.
    if (!this.streaming && this.segment.trim() && chatStatusFilterDisabled()) {
      this.send('progress', { message: this.segment.trim().slice(0, 140), stage: 'agent' });
      this.segment = '';
    }
    // A withheld live tail is answer text mid-flight — flush it before resetting.
    if (this.streaming && this.held.trim() && !this.suppressed) {
      this.appendAnswer(this.held);
    }
    this.held = '';
    this.segment = '';
    // NOTE: if we were already streaming (answer text crossed holdback, THEN the
    // model called a tool), the streamed prefix stays — acceptable per plan C3;
    // the doctrine instructs the model to research first, answer last.
    this.streaming = false;

    // Status lines carry the REAL target of the tool call (query / host /
    // task — owner directive 2026-08-30: no canned "Digby is checking X…"
    // when the actual argument is right here).
    // Copy: status-voice.ts STATUS.tool (one voice for every status line).
    if (name === 'search_memory') {
      this.progress(STATUS.tool.memory(args?.query), 'agent');
    } else if (name === 'web_pipe') {
      this.progress(STATUS.tool.research(args?.query, Array.isArray(args?.urls) ? args.urls.length : 0), 'model-searching');
    } else if (/search/i.test(name)) {
      this.searchCount += 1;
      this.progress(STATUS.tool.search(args?.query), 'model-searching');
    } else if (name.startsWith('scrape')) {
      this.progress(STATUS.tool.read(hostOf(args?.url)), 'model-searching');
    } else if (name === 'browser_task') {
      this.progress(STATUS.tool.browse(args?.task), 'model-searching');
    } else if (name === 'delegate' || name === 'delegate_parallel') {
      this.progress(STATUS.tool.delegate(Array.isArray(args?.tasks) ? args.tasks.length : 0, args?.task || args?.title), 'agent');
    } else {
      const d = toolDetail(name, args);
      // No raw tool ids in the status line (owner directive 2026-07-24; 2026-09-15).
      this.progress(STATUS.tool.other(d && d !== name ? d : ''), 'agent');
    }
  }

  private onToolResult(name: string, result: any): void {
    // Collect source URLs (first few per result) for complete.sources.
    // Filter BEFORE counting toward the caps: tool results often LEAD with
    // redirect/consent/search-host junk, and letting those consume the
    // 5-per-result / 12-total slots starved out the real citations further down
    // the text (review 2026-08-16 — same operator-order bug as the SERP scan).
    //
    // LISTING-SHAPED RESULTS ARE NOT CITATIONS (ticket 659b5074): a
    // github_search_code result is an index listing, not a document the run
    // read — the model's own throwaway probe ({"query":"test"}) returned its
    // org's whole tt-metal repo as blob URLs, and those rendered as the
    // Sources chips under an unrelated legal-invoice answer. The same class
    // as isNonCitationHost (a SERP page is never a citation), one level up:
    // the tool's OWN listing marker gates it, so a result can never pose as
    // citations just because it is URL-dense. Document-shaped GitHub reads
    // (github_get_file_contents) stay harvestable. Kill switch:
    // GITHUB_LISTING_SOURCES_DISABLED=1 restores the old harvest.
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? '');
    if (!githubListingSourcesDisabled() && GITHUB_CODE_SEARCH_LISTING_RE.test(text.slice(0, 400))) return;
    // STORED MATERIAL IS NOT A CITATION (ticket 23e80d1e): a Sources chip means
    // "a page THIS answer read". Tools that read back our own store — memory
    // hits, prior chat text, canvases, knowledge documents, worktree files, the
    // feedback inbox — merely surface content whose URLs are provenance of the
    // stored object. The occurrence: a stored `youtube_pipe` finding carried its
    // video URL, `search_memory` returned it, and the owner saw "a youtube
    // source for some random game" under an unrelated answer. Gating the whole
    // class (not just search_memory) is deliberate — the same harvest fired
    // through every one of these doors. Web tools stay harvestable: they ARE
    // what the run read. Kill switch: STORED_MATERIAL_SOURCES_DISABLED=1.
    if (STORED_MATERIAL_TOOLS.has(name) && !storedMaterialSourcesDisabled()) return;
    const urls = text.match(/https?:\/\/[^\s"'\\)\]}>]+/g) || [];
    let takenFromThisResult = 0;
    for (const u of urls) {
      if (takenFromThisResult >= 5 || this.sources.size >= 12) break;
      const clean = unwrapRedirectUrl(u.replace(/[.,;]+$/, ''));
      if (isNonCitationHost(clean)) continue;
      const before = this.sources.size;
      this.sources.add(clean);
      if (this.sources.size > before) takenFromThisResult++;
    }
  }

  private onSubagentEnd(data: any): void {
    // Cards are keyed by SEAT when the caller says which seat produced the
    // draft (owner 2026-09-15 — two seats on the same vendor no longer share
    // one card, and the label follows the seat, not the model); the legacy
    // vendor key is the fallback for callers that pass none.
    const model = String(data?.cardKey || modelCardKey(String(data?.model || 'worker')));
    const persona = String(data?.persona || personaFor(String(data?.model || '')));
    const summary = String(data?.summary ?? '');
    const failed = /^\[WORKER FAILED/.test(summary) || !summary.trim();
    this.send('model-response', {
      model,
      response: failed ? '' : summary,
      time: Number(data?.time ?? 0),
      modelUsed: String(data?.model || model),
      persona,
      webSearchUsed: true,
      ...(failed ? { error: `${persona} did not return a draft` } : {}),
    });
  }

  /** Run finished — flush buffered/withheld text (unless the marker cut it). */
  finish(): void {
    if (!this.suppressed) {
      const rest = (this.streaming ? this.held : this.segment);
      if (rest.trim()) {
        this.appendAnswer(rest);
      }
    }
    this.segment = '';
    this.held = '';
    this.streaming = false;
  }

  /**
   * Clear per-attempt text-pipeline state so a retried model turn starts clean
   * (PR #292 review, feedback 5f22a689): a stale `suppressed` would swallow the
   * retry's ENTIRE stream (silently reproducing the blank bubble); a stale
   * sub-holdback `segment` would prefix the retry with the failed attempt's
   * leaked markup. Only called when `answer` is empty (the orchestrator retry
   * gate), so no forwarded text is lost; accumulated cross-attempt telemetry
   * (sources, searchCount, webSearchUsed) is kept — attempt 1's research was
   * real.
   */
  resetForRetry(): void {
    this.segment = '';
    this.held = '';
    this.streaming = false;
    this.suppressed = false;
    // FIRST-WORD OPENER (ticket 4f7263e4): the retry attempt gets its own opener
    // (a suppressed attempt-1 opener never reached the user). answerSansOpener
    // is intentionally NOT reset: it excludes openers by construction, so it
    // already reads "content only, attempt-agnostic" — the F1 gates read it
    // before AND after a resetForRetry and see the same emptiness verdict.
    this.deliveredOpener = false;
  }
}
