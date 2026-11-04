/**
 * Plain-chat support for CodeSessionView (One-Session Platform P2 — chat 2922e8f6).
 *
 * The unified stream endpoint (`/crossmodel/chats/:id/stream`) serves BOTH
 * pipelines, but plain chat runs emit the LEGACY event vocabulary
 * (chunk / thinking-summary / agent-activity / ask-user / chat-title / complete…)
 * while CodeSessionView speaks the CODING vocabulary (text / reasoning /
 * tool_call / tool_result / subagent_* / ask_user / complete{finalText}…).
 * This module is the pure, unit-testable bridge: transcript mapping, the
 * per-connection event normalizer, and the plain-send SSE URL builder.
 * Zero backend changes. See docs/ONE_SESSION_PLATFORM.md (Phase P2).
 */
import type { CodingMessage, PlainMessageMeta } from '@/lib/api/coding';
import { ensureFreshAuthCookie } from '@/lib/api-client';
import { mergeDeltaIntoParts, splitSummaryLabel } from '@/lib/reasoning-merge';
import { imagePartFromFrame } from '@/lib/image-frame-part';
import type { ActivePatienceMode } from '@/lib/preferences';
import { depthPrefToWire, parseCheckState, parseChips, progressTextFor, reduceCheckState, type CheckState, type DepthChip, type DepthQuotaView, type PlainModeSource } from '@/lib/depth-ux';
import { TASK_EVENT_TYPE, parseTaskEvent } from '@/lib/task-card';
import { upsertTaskPartParts } from '@/lib/transcript-parts';
import { reasoningVisible } from '@/lib/reasoning-visibility';

/**
 * stripForStorage — the CANONICAL storage strip (C3, ticket 71b1fec6: the
 * legacy view and its page.tsx twin are deleted — this is the only copy).
 * Canvas + follow-up blocks are removed (they render from message metadata /
 * canvas events, not content); [SEND_EMAIL] blocks are PRESERVED so a future
 * email-card renderer can parse them.
 */
export function stripForStorage(text: string): string {
  if (!text) return '';
  return text
    .replace(/\[CANVAS:[^\]]+\][\s\S]*?\[\/CANVAS\]/gi, '')
    .replace(/\[CANVAS\][\s\S]*?\[\/CANVAS\]/gi, '')
    .replace(/\[CANVAS[^\]]*\][\s\S]*/gi, '')
    .replace(/\[FOLLOWUPS\][\s\S]*?\[\/FOLLOWUPS\]/gi, '')
    .replace(/\[FOLLOWUPS\][\s\S]*$/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * stripLiveTags — the CANONICAL live-bubble strip (C3, ticket 71b1fec6: the
 * legacy view's page.tsx stripCanvasTags twin is deleted — this is the only
 * copy). Unlike stripForStorage it also removes [SEND_EMAIL] blocks (the email
 * card renders only from persisted content) and hides PARTIAL blocks mid-stream
 * (from an opening tag to the end of the accumulated text), so raw canvas
 * markup never flashes in the streaming bubble. Render-time only — the raw
 * accumulation stays authoritative, exactly like the legacy view.
 */
export function stripLiveTags(text: string): string {
  if (!text) return '';
  return text
    .replace(/\[CANVAS:[^\]]+\][\s\S]*?\[\/CANVAS\]/gi, '')
    .replace(/\[CANVAS\][\s\S]*?\[\/CANVAS\]/gi, '')
    .replace(/\[CANVAS[^\]]*\][\s\S]*/gi, '')
    .replace(/\[FOLLOWUPS\][\s\S]*?\[\/FOLLOWUPS\]/gi, '')
    .replace(/\[FOLLOWUPS\][\s\S]*$/gi, '')
    .replace(/\[SEND_EMAIL[^\]]*\][\s\S]*?\[\/SEND_EMAIL\]/gi, '')
    .replace(/\[SEND_EMAIL[\s\S]*$/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Map a stored plain-chat GET payload (crossModelApi.getChat) into the
 * CodingMessage rows CodeSessionView renders. Persisted `parts` (One-Digby
 * agent runs write them) pass through so the work trail renders via
 * AssistantParts; content falls back to CodeTranscriptMarkdown. Message
 * metadata (followUps / sources / models…) rides `plainMeta` so the ported
 * legacy transcript extras (increment 2) render in the unified view.
 */
export function mapPlainMessages(full: any): CodingMessage[] {
  return (full?.messages || []).map((m: any, i: number) => {
    const base = (m.metadata && typeof m.metadata === 'object' ? m.metadata : undefined) as PlainMessageMeta | undefined;
    // Shared-project author attribution (58ffcf86; C2 port, ticket 71b1fec6 —
    // mirrors the legacy view's mapStoredMessages): a stored USER row stamped
    // with metadata.authorId gets its display name resolved here from the
    // payload's additive messageAuthors map (one batched server-side lookup —
    // no per-message fetches). Assistant/machine rows are never stamped; a
    // deleted author's name stays unresolved and the footnote falls back to
    // 'teammate'. Shallow-copied so the fetched payload is never mutated.
    const stamped = !!(base && m.role === 'user' && typeof base.authorId === 'string' && base.authorId);
    const resolvedName = stamped ? full?.messageAuthors?.[base!.authorId!] : undefined;
    const plainMeta = stamped
      ? { ...base!, ...(typeof resolvedName === 'string' && resolvedName ? { authorName: resolvedName } : {}) }
      : base;
    return {
      // The paged getChatById DTO now carries the DB row id (React keys + the
      // paging cursor family). Legacy/unpaged payloads omit it — synthesize a
      // stable-enough fallback so keys are never `undefined`.
      id: m.id ?? `m-${i}-${m.timestamp ?? m.createdAt ?? ''}`,
      role: m.role,
      content: m.role === 'assistant' ? stripForStorage(m.content || '') : (m.content || ''),
      // Ticket dc7fd17a: historically persisted text parts were stored
      // UNSTRIPPED (the backend only cleaned content), so a reloaded assistant
      // row could render raw "[FOLLOWUPS]"/[CANVAS] markup — AssistantParts
      // renders text parts verbatim and the view ignores content when parts
      // exist. Strip text parts on load exactly like the complete-event
      // normalizer does for the live epoch; rows persisted after the backend
      // persist-side strip are already clean and pass through unchanged.
      parts: Array.isArray(m.parts) && m.parts.length
        ? m.parts.map((p: any) => (p?.type === 'text' ? { ...p, text: stripForStorage(p.text || '') } : p))
        : undefined,
      plainMeta,
      createdAt: m.createdAt ?? m.timestamp,
    };
  });
}

/**
 * Map the GET payload's `pendingMessages` (ticket c0b2b0c8) into CodingMessage
 * rows. The backend prefixes each row's id with `pending-` so these NEVER
 * collide with persisted row ids; the view unions the ids into
 * pendingSteerIds, which routes them through partitionQueuedEchoes into the
 * queued-echo partition — the queued bubble renders in-flow at the bottom on
 * reload/re-attach exactly as it did in the sending tab, and drops the moment
 * the drain persists the real row (the next reload's page no longer lists
 * the pending entry and dropPrevAbsent releases it).
 */
export function mapPlainPendingMessages(full: any): CodingMessage[] {
  return (full?.pendingMessages || []).map((m: any) => ({
    id: m.id as string,
    role: 'user' as const,
    content: m.content || '',
    createdAt: m.timestamp ?? m.createdAt,
  }));
}

/**
 * Shared-project chats (58ffcf86 → C2 port, ticket 71b1fec6): a user message
 * authored by a DIFFERENT account than the signed-in viewer — rendered in a
 * distinct bubble tint with a small "From: <name>" footnote (mirrors the
 * legacy view's isTeammateMessage). The viewer's own messages and legacy rows
 * (no authorId stamp) return false and render exactly as before.
 */
export function isPlainTeammateMessage(meta: PlainMessageMeta | undefined, viewerId: string | null | undefined): boolean {
  return !!(meta?.authorId && viewerId && meta.authorId !== viewerId);
}

/** One attachment staged in the page's bar and consumed by a plain send —
 *  the subset of the page's AttachmentInfo the view needs (P2 increment 2). */
export interface PlainAttachmentRef {
  uploadId: string;
  filename: string;
  type: string;
  /** Blob URL for immediate image thumbnails on the echoed user bubble. */
  localPreview?: string;
}

export interface NormalizedEvent { type: string; data: any }

/**
 * One normalizer PER STREAM CONNECTION (it accumulates the answer text so the
 * legacy `complete` — which carries no payload by design — can synthesize the
 * coding `complete.finalText`; without it the view would append an empty
 * assistant bubble). Events with no coding equivalent return null and are
 * dropped by the caller (routing status lines, model-response +
 * imessage-draft page panels, init housekeeping). `progress` IS forwarded
 * (C3 kid flip: the view's live.status working line is the coding-vocabulary
 * status surface — kid status lines are a D5 rail). `canvas` and `queued` are
 * returned null — the caller forwards them to plain-mode callbacks first.
 */
export function makeLegacyNormalizer(opts: {
  /** Inline task card (cohesive chat, 2026-09-28): true when a PERSISTED row of
   *  the transcript already carries this taskId — the frame then updates THAT
   *  row's card (the view's `task` handler) and is NOT folded into this turn's
   *  parts, so `complete` never appends a second card under the new bubble. */
  hasTask?: (taskId: string) => boolean;
} = {}): (type: string, data: any) => NormalizedEvent | null {
  let answer = '';
  // Metadata accumulated across the stream so `complete` can carry everything
  // the legacy view persisted in message.metadata (review M2): full per-model
  // responses from 'model-response' (the complete payload truncates them for
  // Cloudflare), the init event's modelSet/modelLabels, and the Auto router's
  // 'routing' decision.
  const models: Record<string, any> = {};
  let modelSet: string | undefined;
  let modelLabels: Record<string, string> | undefined;
  let routing: any;
  // Depth UX (2026-09-26, lib/depth-ux.ts): the harness's last `check_state`
  // and the followups event's server-appended chips ride into `complete` so
  // the appended bubble carries its pill state + the Dig-deeper chip without
  // a reload (the SSE closes at complete — later states arrive via the poll).
  let check: CheckState | undefined;
  let chips: DepthChip[] = [];
  // Accumulate the normalized parts as they stream so `complete` can emit them:
  // the appended message then KEEPS its work trail (the view clears live parts
  // in the same tick it appends the message — review M5).
  let parts: any[] = [];
  const pushDelta = (kind: 'text' | 'reasoning', delta: string, label?: string) => {
    // Per-label coalescing (owner report 2026-08-30 — the "Thought process"
    // row spam): concurrent personas stream reasoning interleaved at token
    // rate, and the old trailing-only label-keyed merge (01c69ca9 review B2)
    // opened a NEW part on every label alternation — dozens of collapsed rows
    // per turn, each a mid-word fragment. mergeDeltaIntoParts appends to the
    // persona's existing part wherever it sits (the unified view's port of the
    // legacy feed's agentReasoningByLabelRef, page.tsx 2026-07). Unlabeled
    // reasoning rides the most recent reasoning part (ticket 6201d579: a
    // thinking-summary tick must never split a persona run).
    parts = mergeDeltaIntoParts(parts, kind, delta, { label });
  };
  return (type: string, data: any): NormalizedEvent | null => {
    switch (type) {
      case 'init': {
        if (data?.mode === 'frontier' || data?.mode === 'open_source') modelSet = data.mode;
        if (data?.modelLabels && typeof data.modelLabels === 'object') modelLabels = data.modelLabels;
        return null;
      }
      case 'model-response': {
        if (data?.model) models[data.model] = data;
        return null;
      }
      case 'routing': {
        if (data && typeof data.level === 'string') routing = data;
        return null;
      }
      // Depth UX (2026-09-26): the harness's check pill state. Malformed
      // payloads are dropped; a valid one is remembered for `complete`.
      case 'check_state': {
        const parsed = parseCheckState(data);
        if (!parsed) return null;
        check = reduceCheckState(check, parsed);
        return { type: 'check_state', data: parsed };
      }
      // The legacy followups event carries the questions `complete.followUps`
      // repeats (dropped here, as before) — plus, since the compute policy, the
      // server-appended chips (ONE escalate / signin_deeper). Remembered for
      // `complete`; a later followups frame replaces an earlier one.
      case 'followups': {
        const parsed = parseChips(data?.chips);
        if (parsed.length) chips = parsed;
        return null;
      }
      case 'chunk': {
        const delta = String(data?.content ?? '');
        answer += delta;
        pushDelta('text', delta);
        return { type: 'text', data: { delta } };
      }
      case 'thinking-summary': {
        // Thinking stays hidden (2026-10-04, lib/reasoning-visibility.ts): the server no longer sends this; an older
        // backend's frame is dropped here so it never becomes a part (nor a guest's saved history).
        if (!reasoningVisible()) return null;
        // Summaries carry a `Label: …` persona prefix server-side
        // (sse-adapter.ts / chat-agent.service.ts) — split it so the summary
        // routes into THAT persona's reasoning part instead of
        // wildcard-merging into whichever persona streamed last.
        const { label, text } = splitSummaryLabel(String(data?.summary ?? ''));
        const delta = `${text}\n`;
        pushDelta('reasoning', delta, label);
        return { type: 'reasoning', data: { delta, label } };
      }
      case 'agent-activity': {
        const e = data || {};
        if (e.kind === 'reasoning') {
          if (!reasoningVisible()) return null; // thinking stays hidden (2026-10-04)
          // Backend emits reasoning as `{ kind, label, delta }` (sse-adapter
          // legacy-activity path) — reading `text` rendered blank (review H1).
          // NO trailing newline per delta (ticket 01c69ca9): these arrive at
          // token rate (a few chars each), so appending '\n' to every event
          // accumulated 'tok1\ntok2\n…' — expanded thinking rendered one tiny
          // fragment per line ("smushed to a few characters, word wrapped").
          // The delta carries the model's own whitespace; concatenate raw,
          // exactly like the coding pipeline's coalescer and the legacy feed.
          const delta = String(e.delta ?? e.text ?? '');
          pushDelta('reasoning', delta, e.label);
          return { type: 'reasoning', data: { delta, label: e.label } };
        }
        if (e.kind === 'tool') {
          // Owner 2026-09-15: the backend's `detail` is the query / url / task
          // snippet — shape it as the arg toolSummary reads, so the row says
          // "Searched the web · <query>" instead of the bare verb; and stamp
          // the SEAT (label: Digby / Double Checker / …) so the Double
          // Checker's parallel research is attributed, never mistaken for
          // Digby's (ToolCard + the tool-activity accordion read it).
          const args = toolArgsFromDetail(e.name, e.detail);
          const part: any = { type: 'tool_call', name: e.name, args, ...(e.label ? { label: e.label } : {}) };
          parts.push(part);
          return { type: 'tool_call', data: { name: e.name, args, ...(e.label ? { label: e.label } : {}) } };
        }
        if (e.kind === 'tool_done') {
          // Backend sends `{ kind, name, size }` — no `detail` (review M3).
          // The seat label rides the normalized data exactly as `tool` does
          // above (53c0b979): the live view's pushPart reads data.label, and
          // an unlabelled live tool_result would break the text walk-back at
          // a concurrent seat's result card.
          const result = e.detail ?? (typeof e.size === 'number' ? `${e.size} B` : '');
          parts.push({ type: 'tool_result', name: e.name, result, ...(e.label ? { label: e.label } : {}) });
          return { type: 'tool_result', data: { name: e.name, result, ...(e.label ? { label: e.label } : {}) } };
        }
        if (e.kind === 'sub_start') return { type: 'subagent_start', data: { role: e.label, title: e.detail || e.label } };
        if (e.kind === 'sub_end') return { type: 'subagent_end', data: { role: e.label, title: e.detail || e.label } };
        return null;
      }
      case 'ask-user': return { type: 'ask_user', data };
      case 'ask-user-resolved': return { type: 'ask_user_resolved', data };
      // Inline task card (cohesive chat, 2026-09-28 — lib/task-card.ts): the
      // harness's task lifecycle frame. The parsed payload rides the accumulated
      // parts as ONE `task` part per taskId (replaced in place on every update)
      // so `complete` hands the appended bubble its card exactly as the
      // persisted row will carry it — UNLESS an earlier row already carries the
      // task (`opts.hasTask`: a background continuation / sub-session reports
      // on the turn that started it while the user is on a later turn — the
      // chat's live run forwards every frame): then the frame is only
      // forwarded, the view updates that row's card, and this turn's bubble
      // gets no second card. Malformed ⇒ dropped.
      case TASK_EVENT_TYPE: {
        const task = parseTaskEvent(data);
        if (!task) return null;
        if (!opts.hasTask?.(task.taskId)) parts = upsertTaskPartParts(parts, task);
        return { type: TASK_EVENT_TYPE, data: task };
      }
      // Browser program (UI Phase 6a): per-action agent-browse transparency —
      // emitted by BOTH the legacy mode='browser_agent' full-session path and
      // the forwarded browser_task tool path (chat-agent sse-adapter). Maps to
      // the coding-vocabulary event the unified view's browser panel/sheet
      // consumes; payload verbatim ({action, ok, url, driver, preview,
      // reasoning} / {action:'screenshot', …, screenshotBase64}). Frames
      // without a string action are dropped (lib/browser-activity.ts would
      // no-op on them anyway). The existing "Reading a page" progress line is
      // untouched — surfaces that don't adopt the panel render exactly as
      // before.
      case 'browser-observation': {
        return data && typeof data === 'object' && typeof data.action === 'string' && data.action
          ? { type: 'browser_observation', data }
          : null;
      }
      // Computer use (2026-09-09): the legacy mode='browser_agent' full-session
      // path can hand off to the computer agent, whose frames arrive as
      // `computer-observation`. Same panel, tagged driver:'computer' (JPEG
      // screenshots) — the tool path normalizes identically server-side
      // (tool-executor forwardableBrowserObservation).
      // Screenshots in the chat (2026-09-23): the final browser/computer frame
      // as an inline assistant image part (sse-adapter passes the coding-lane
      // `image` event through under the same name).
      // Generated images (2026-09-24): the generate_image tool's live `image`
      // event carries base64 `data` for the instant render PLUS the lazy
      // `url` / `fileId` / `prompt` the persisted part keeps (the transcript
      // reload serves the bytes from /generated-files/<id>/inline, never
      // base64). A REPLAYED frame (cross-instance mirror / durable log) is
      // url-only — the shared lib/image-frame-part mapping (also the coding
      // lane's) renders it from the lazy url like the persisted part.
      case 'image': {
        const part = imagePartFromFrame(data);
        if (!part) return null;
        parts.push(part);
        return { type: 'image', data: part };
      }
      case 'computer-observation': {
        return data && typeof data === 'object' && typeof data.action === 'string' && data.action
          ? { type: 'browser_observation', data: { ...data, driver: 'computer', mime: data.mime || 'image/jpeg' } }
          : null;
      }
      // Status lines (C3 kid flip, design D5): the coding vocabulary HAS a
      // status surface (live.status renders in the working line, throttled by
      // the view), so forward instead of dropping. This is a named kid rail —
      // Digby Kids' dynamically generated status lines ride 'progress' — and
      // restores the legacy streamingStatus parity for adults too.
      // Depth UX (2026-09-26): a progress frame carrying a KNOWN `key` from
      // the fixed compute-policy set renders the client lookup table's text
      // (never model prose); everything else keeps the server's own message.
      case 'progress': {
        const line = progressTextFor(data);
        return line ? { type: 'progress', data: line.key ? { message: line.message, key: line.key } : { message: line.message } } : null;
      }
      case 'chat-title': return { type: 'session_title', data: { title: data?.title } };
      // Keep the original flags (interrupted/stopped drive the attach-path
      // toast) and hand back the accumulated parts — review M4/M5.
      case 'complete': {
        // Strip canvas/follow-up markup from the answer that becomes the
        // message content + its persisted-look text parts (review H3 — raw
        // [CANVAS] blocks used to land verbatim in the appended bubble), and
        // merge the full 'model-response' payloads over the complete event's
        // truncated ones (page.tsx does the same merge) so the More-info
        // panel shows real responses on the just-answered turn (review M2).
        const mergedModels: Record<string, any> = {};
        for (const key of Object.keys({ ...models, ...(data?.models || {}) })) {
          mergedModels[key] = { ...(data?.models?.[key] || {}), ...(models[key] || {}) };
        }
        // finalText source: the backend normally omits it (H3 slim complete
        // events) and the chunk accumulator is the answer. Exception: after a
        // step-0 cross-check reconcile the wire carries the RECONCILED full
        // text — prefer it over the accumulator (which holds the unreconciled
        // render). Either way it goes through stripForStorage (review H3).
        const rawFinal = typeof data?.finalText === 'string' && data.finalText.trim() ? data.finalText : answer;
        // A wire finalText is a SWAP (step-0 reconcile / guard replacement):
        // the accumulated chunk text is the superseded draft, and the view
        // renders PARTS over content — ship the swapped text as the one text
        // part so the just-answered bubble shows the reconciled answer without
        // a reload (audit 2026-09-18: the swap only ever reached `content`).
        const swapped = typeof data?.finalText === 'string' && data.finalText.trim().length > 0;
        const textParts = swapped
          ? [...parts.filter(p => p.type !== 'text'), { type: 'text' as const, text: stripForStorage(rawFinal) }]
          : parts.map(p => (p.type === 'text' ? { ...p, text: stripForStorage(p.text || '') } : p));
        return {
          type: 'complete',
          data: {
            ...data,
            finalText: stripForStorage(rawFinal),
            parts: textParts,
            ...(Object.keys(mergedModels).length ? { models: mergedModels } : {}),
            ...(modelSet ? { modelSet } : {}),
            ...(modelLabels ? { modelLabels } : {}),
            ...(routing && !data?.routing ? { routing } : {}),
            // Depth UX: the wire's own check/chips win; otherwise the last
            // streamed check_state and the followups event's chips ride along.
            ...(check && !parseCheckState(data?.check) ? { check } : {}),
            ...(chips.length && !parseChips(data?.chips).length ? { chips } : {}),
          },
        };
      }
      case 'error': return { type: 'error', data };
      default: return null;
    }
  };
}

/**
 * Build the just-answered turn's PlainMessageMeta from a normalized `complete`
 * payload (review M2) — mirrors the metadata page.tsx assembles on complete so
 * Sources pills / follow-up chips / the admin More-info panel render
 * immediately instead of only after a reload. Returns undefined when the
 * payload carries nothing renderable.
 */
export function buildPlainMeta(data: any, requestMode: string): PlainMessageMeta | undefined {
  const followUps = (Array.isArray(data?.followUps) ? data.followUps : [])
    .filter((f: any) => typeof f === 'string' && f.trim() && f !== 'undefined');
  const models = data?.models && typeof data.models === 'object' && Object.keys(data.models).length ? data.models : undefined;
  const sources = Array.isArray(data?.sources) && data.sources.length ? data.sources : undefined;
  // Depth UX (2026-09-26): the pill state, the persisted-look depth plan and
  // the server chips ride the same meta so the just-answered bubble renders
  // its pill + Dig-deeper chip immediately (reload parity via metadata).
  const check = parseCheckState(data?.check) ?? undefined;
  const depth = data?.depth && typeof data.depth === 'object' ? data.depth : undefined;
  const chips = parseChips(data?.chips);
  if (!followUps.length && !models && !sources && !check && !depth && !chips.length && data?.pendingCrossCheck !== true) return undefined;
  // Under Auto the displayed mode is the level the router actually picked
  // (never 'auto') — same fallback chain as page.tsx's complete handler.
  const mode = requestMode === 'auto' ? (data?.routing?.level ?? 'thinking') : requestMode;
  return {
    mode,
    ...(data?.modelSet ? { modelSet: data.modelSet } : {}),
    ...(data?.modelLabels ? { modelLabels: data.modelLabels } : {}),
    ...(models ? { models } : {}),
    ...(sources ? { sources } : {}),
    ...(followUps.length ? { followUps } : {}),
    ...(typeof data?.synthesisTime === 'number' ? { synthesisTime: data.synthesisTime } : {}),
    ...(typeof data?.totalTime === 'number' ? { totalTime: data.totalTime } : {}),
    // Owner 2026-09-18: the Double Checker was still working when this answer
    // shipped — the bubble shows "still working" and polls for the revision.
    ...(data?.pendingCrossCheck === true ? { pendingCrossCheck: true } : {}),
    // Ticket 318b3175 (echo-only, never persisted): the complete event's
    // finalText REPLACED the streamed text at finalize (cross-check reconcile,
    // action-guard strike, unbacked-claim rewrite…). The bubble renders a
    // "corrected before delivery" note so the live swap reads as a correction,
    // not a glitch (the owner watched a long streaming answer "shrink").
    ...(data?.corrected === true ? { corrected: true } : {}),
    ...(check ? { check } : {}),
    ...(depth ? { depth } : {}),
    ...(chips.length ? { chips } : {}),
  };
}

/** Poll cadence / bound for a pending late cross-check: the checker's hard cap is
 *  15 min from the run start (CROSS_CHECK_HARD_MS) plus a ≤2.5 min reconcile;
 *  the poll starts at delivery, so 16 min covers the whole window. */
export const REVISION_POLL_MS = 8_000;
export const REVISION_POLL_MAX_MS = 16 * 60_000;
/** Rows fetched per poll (the newest N rows of the chat) — wide enough that a pending
 *  row a few turns back (conversation_moved) is still on the page (audit 2026-09-26
 *  sse-ui-restore-5: a 6-row page marked it 'interrupted' at the bound even when the
 *  DB said revised / addendum). A pending row outside it can never be observed from
 *  this tab (depth-ux-seams.ts pendingRowsToPoll settles it honestly). */
export const REVISION_POLL_PAGE = 20;

/**
 * Poll the persisted row of a just-answered turn while its
 * `metadata.pendingCrossCheck` is true (owner 2026-09-18 — the Double
 * Checker's draft reconciles into the message AFTER the first answer ships).
 * Resolves with the mapped row once the flag clears (revised or not), or null
 * when the bound passes / the caller cancels. `fetchChat` is injected so the
 * loop is unit-testable; the view passes crossModelApi.getChat.
 */
export async function pollPlainRevision(
  chatId: string,
  messageId: string,
  fetchChat: (id: string, opts: { messageLimit: number }) => Promise<any>,
  opts: { shouldContinue?: () => boolean; intervalMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CodingMessage | null> {
  const interval = opts.intervalMs ?? REVISION_POLL_MS;
  const maxMs = opts.maxMs ?? REVISION_POLL_MAX_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    await sleep(interval);
    if (opts.shouldContinue && !opts.shouldContinue()) return null;
    let full: any = null;
    // A row followed by a few newer turns (the user moved on — conversation_moved)
    // must still be found (audit 2026-09-26 sse-ui-restore-5: a 6-row page marked it
    // 'interrupted' at the bound even when the DB said revised / addendum).
    try { full = await fetchChat(chatId, { messageLimit: REVISION_POLL_PAGE }); } catch { full = null; }
    if (!full) continue;
    const row = mapPlainMessages(full).find((m) => m.id === messageId);
    if (!row) continue; // paged out / not in the newest page — keep polling until the bound
    if (!plainRevisionPending(row.plainMeta)) return row;
  }
  return null;
}

/** A row still awaits its check: the legacy pendingCrossCheck flag OR a depth
 *  UX check state of 'checking' (the harness clears both when the reconcile
 *  lands, is skipped, or is interrupted). Neither set ⇒ settled (legacy rows). */
export function plainRevisionPending(meta: PlainMessageMeta | undefined): boolean {
  return meta?.pendingCrossCheck === true || meta?.check?.state === 'checking';
}

/** Past this age a persisted 'checking' row can no longer be updated by the
 *  late check (its hard cap is REVISION_POLL_MAX_MS from delivery) — the pill
 *  reads "Check didn't finish" instead of spinning forever. */
export const RESTORED_CHECK_SETTLE_MS = REVISION_POLL_MAX_MS + 4 * 60_000;

/**
 * Settle a RESTORED row's check state (owner report 2026-09-26: a reload showed
 * the previous run's "Checking…" as if a stream were attached). A row whose
 * metadata still says 'checking' / pendingCrossCheck is honest ONLY while the
 * late check can still land AND something in this tab will poll it; otherwise
 * the pill must say the check didn't finish. `canPoll:false` (guest rows —
 * nothing can update them) or an age past RESTORED_CHECK_SETTLE_MS settles it
 * to 'interrupted' (pendingCrossCheck cleared); a young pollable row is
 * returned unchanged (the caller starts pollPlainRevision). Every other meta
 * passes through untouched — checked / updated / skipped render as persisted.
 */
export function settleRestoredCheck(
  meta: PlainMessageMeta | undefined,
  opts: { createdAt?: string; canPoll: boolean; now?: number },
): PlainMessageMeta | undefined {
  if (!plainRevisionPending(meta)) return meta;
  const created = opts.createdAt ? Date.parse(opts.createdAt) : NaN;
  const age = Number.isFinite(created) ? (opts.now ?? Date.now()) - created : Number.POSITIVE_INFINITY;
  if (opts.canPoll && age < RESTORED_CHECK_SETTLE_MS) return meta;
  return markCheckInterrupted(meta);
}

/** The row's meta with its check settled to 'interrupted' (pendingCrossCheck cleared). */
export function markCheckInterrupted(meta: PlainMessageMeta | undefined): PlainMessageMeta {
  const { pendingCrossCheck: _pending, ...rest } = meta ?? {};
  return { ...rest, check: { state: 'interrupted' } };
}

/**
 * A RESTORED transcript (the initial plain load, the post-run reload): every
 * assistant row goes through settleRestoredCheck. Kept OUT of mapPlainMessages
 * on purpose — the revision poll maps rows too and must see the raw pending
 * state to keep polling. Rows other than assistant rows pass through.
 */
export function settleRestoredRows(rows: CodingMessage[], opts: { canPoll: boolean; now?: number } = { canPoll: true }): CodingMessage[] {
  return rows.map((m) => {
    if (m.role !== 'assistant' || !plainRevisionPending(m.plainMeta)) return m;
    const settled = settleRestoredCheck(m.plainMeta, { createdAt: m.createdAt, canPoll: opts.canPoll, now: opts.now });
    return settled === m.plainMeta ? m : { ...m, plainMeta: settled };
  });
}

/**
 * canvasEventToText — C3 (ticket 71b1fec6) GUEST content preservation: guest
 * sessions mount no workspace panel, so a legacy `canvas` SSE event cannot
 * open/update a CanvasPanel. The view feeds the returned string into the
 * answer stream as a text delta instead, so the guest still SEES the content
 * (only the panel/editor is gone — the sign-up CTA surface). '' = nothing
 * usable (caller drops the event). Signed-in plain + fallback chats keep the
 * real panel via plain.onCanvas and never call this.
 */
export function canvasEventToText(data: any): string {
  const content = typeof data?.content === 'string' ? data.content.trim() : '';
  if (!content) return '';
  const title = typeof data?.title === 'string' ? data.title.trim() : '';
  const head = title && title !== 'Untitled' ? `**${title}**\n\n` : '';
  return `\n\n${head}${content}`;
}

/**
 * The depth slice of the `plain` config page.tsx hands CodeSessionView — the
 * wire mode + modeSource of every human send, the research rung's quota and
 * the Dig-deeper switch — extracted (audit 2026-09-26, tests-gaps-10) so the
 * per-origin OUTPUT is unit-tested instead of pinning the page's object
 * literal as source text. Pure; no behaviour change from the inlined literal:
 *
 *   · `depthPrefToWire` (roster 2026-10-06 B-3 — the Account → Advanced
 *     presets and the legacy composer picker are retired; the Advanced TAB
 *     itself removed 2026-10-27, ticket c99b404a): signed-in = 'auto'
 *     with no modeSource; guests = the forced Ensemble with 'default'; kids =
 *     the pref untouched, no modeSource;
 *   · `deepResearchQuota` rides through to the chip; `digDeeperEnabled` is
 *     false for kids only.
 */
export interface PlainDepthConfigInput {
  /** The page's normalized patience preference (normalizePatienceMode(mode)) — read for kids only. */
  pref: ActivePatienceMode;
  /** Anonymous guest mount (chatlessActive.guest). */
  guest: boolean;
  isKid: boolean;
  deepResearchQuota: DepthQuotaView | null;
}

export interface PlainDepthConfig {
  mode: string;
  modeSource?: PlainModeSource;
  deepResearchQuota: DepthQuotaView | null;
  digDeeperEnabled: boolean;
}

export function buildPlainDepthConfig(input: PlainDepthConfigInput): PlainDepthConfig {
  const { pref, guest, isKid, deepResearchQuota } = input;
  return { ...depthPrefToWire(pref, { guest, isKid }), deepResearchQuota, digDeeperEnabled: !isKid };
}

export interface PlainSendParams {
  /** Owning chat. NULL/undefined = chatId-less send (C3, ticket 71b1fec6):
      anonymous guest sessions + the signed-in createChat-failure fallback ride
      the same open /crossmodel/stream endpoint; conversation context comes
      from the server-side cm_session cookie (24h Redis), not a chat row. */
  chatId?: string | null;
  message: string;
  /** Pipeline mode (fast/thinking/auto/…), as the legacy composer's patience map produces. */
  mode: string;
  /** How `mode` was chosen (the server's label-window vocabulary). Since roster 2026-10-06 B-3 the web
      client sends only 'default' (a guest's forced Ensemble); signed-in Auto and kids send nothing. */
  modeSource?: PlainModeSource;
  /** Depth UX "Dig deeper" (2026-09-26): the assistant message id this send
      escalates. The server runs the NEXT rung not yet spent on that message
      (L1 → verify; L2 → background council) in the same chat. Signed-in,
      chatId-bound sends only — guests never carry it. */
  escalationOf?: string;
  webSearch: boolean;
  uploadIds?: string[];
  /** Guest sessions (ticket 63bb607f): the guest's NAMED anonymous context key
      (client-minted UUID). ChatId-less only — the backend honors it solely in
      the anonymous branch (an unguessable UUID naming an ephemeral 24h Redis
      context; authed requests ignore the param entirely). */
  sessionId?: string;
  /** Guest location (browser geolocation, reverse-geocoded — "City, Country").
      ChatId-less guest sends only; the backend honors it solely for anonymous
      streams and falls back to an approximate IP lookup when it is absent. */
  userLocation?: string;
  /** Ghost mode (2026-10-22): true = this send's models are routed to the
      admin-designated self-hosted endpoint and the turn is kept out of memory
      / learning / cross-chat surfacing. The open /crossmodel/stream endpoint
      reads ?ghost=true; an older backend ignores the unknown param. Sent on
      EVERY send of a ghost-mode conversation (chatId-less guest sessions hold
      the flag client-side; signed-in chats persist it on the chat row and the
      backend applies it server-side, so authed sends never need to carry it). */
  ghost?: boolean;
}

/**
 * Build the plain chat SSE URL, mirroring page.tsx's send path: messages over
 * ~1500 chars pre-register via POST /stream/register (GET URL length limits);
 * the JWT rides the httpOnly cookie (EventSource can't set headers); a cache
 * buster defeats cached SSE responses for structurally identical URLs.
 */
export async function buildPlainStreamUrl(p: PlainSendParams): Promise<string> {
  // The EventSource GET authenticates ONLY via the httpOnly cm_access cookie
  // (EventSource can't set headers) and that JWT lives 15 minutes — after page
  // idle the stream silently arrived anonymous and the message was lost
  // (review H1). Same chokepoint page.tsx's send path uses; covers BOTH the
  // view's send path and the busy-queue passthrough. No-op when fresh/anon.
  await ensureFreshAuthCookie();
  const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  let url: string;
  if (p.message.length > 1500) {
    try {
      const regBody: Record<string, any> = {
        message: p.message,
        mode: p.mode,
        webSearch: p.webSearch.toString(),
      };
      if (p.chatId) regBody.chatId = p.chatId;
      // Label window (2026-09-26): the register body carries modeSource — the
      // backend stores it on the registration and reads it at consume time.
      if (p.modeSource) regBody.modeSource = p.modeSource;
      // Depth UX (2026-09-26): the escalation target rides the register body.
      if (p.escalationOf) regBody.escalationOf = p.escalationOf;
      // Guest sessions (63bb607f): the named anonymous context key rides the
      // register body too (honored once the backend threads it through the
      // token path; the cm_session cookie already covers continuity today).
      if (p.sessionId) regBody.sessionId = p.sessionId;
      // Ghost mode (2026-10-22): rides the register body AND the token URL
      // (the same belt-and-braces as sessionId — the registration stores it
      // so the consume path cannot lose it).
      if (p.ghost) regBody.ghost = 'true';
      if (p.uploadIds?.length) regBody.uploadId = p.uploadIds;
      const regRes = await fetch(`${apiBase}/crossmodel/stream/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(regBody),
      });
      if (!regRes.ok) throw new Error(`Register failed: ${regRes.status}`);
      const { streamToken } = await regRes.json();
      // Guest sessions (audit 2026-09-26 guest-persistence-1): the NAMED session
      // rides the token URL too — the controller reads ?sessionId on every path,
      // and the registration now stores it as well (belt and braces: a >1500-char
      // guest message used to run on the cm_session cookie = the LAST session
      // streamed in this browser).
      url = `${apiBase}/crossmodel/stream?${new URLSearchParams({ streamToken, ...(p.sessionId ? { sessionId: p.sessionId } : {}), ...(p.ghost ? { ghost: 'true' } : {}) })}`;
    } catch {
      // Fallback: truncate and go direct (same as page.tsx — better than silent failure).
      const q = new URLSearchParams({ message: p.message.substring(0, 1500), mode: p.mode, webSearch: p.webSearch.toString() });
      if (p.chatId) q.set('chatId', p.chatId);
      if (p.modeSource) q.set('modeSource', p.modeSource);
      if (p.escalationOf) q.set('escalationOf', p.escalationOf);
      if (p.sessionId) q.set('sessionId', p.sessionId);
      if (p.ghost) q.set('ghost', 'true');
      p.uploadIds?.forEach(id => q.append('uploadId', id));
      url = `${apiBase}/crossmodel/stream?${q}`;
    }
  } else {
    const q = new URLSearchParams({ message: p.message, mode: p.mode, webSearch: p.webSearch.toString() });
    if (p.chatId) q.set('chatId', p.chatId);
    // Label window (2026-09-26): the GET query is the short-message path —
    // same field the register body carries (controller reads req.query.modeSource).
    if (p.modeSource) q.set('modeSource', p.modeSource);
    // Depth UX (2026-09-26): Dig deeper — same field on the short-message GET.
    if (p.escalationOf) q.set('escalationOf', p.escalationOf);
    if (p.sessionId) q.set('sessionId', p.sessionId);
    // Ghost mode (2026-10-22): rides the open stream query on every ghost send.
    if (p.ghost) q.set('ghost', 'true');
    p.uploadIds?.forEach(id => q.append('uploadId', id));
    url = `${apiBase}/crossmodel/stream?${q}`;
  }
  // Guest location rides the GET query on BOTH branches (the register body
  // does not carry it) — the stream handler reads it for anonymous callers only.
  const loc = p.userLocation ? `&${new URLSearchParams({ userLocation: p.userLocation.slice(0, 120) })}` : '';
  return `${url}${loc}&_t=${Date.now()}`;
}

/**
 * Plain ATTACH url (P2 increment 2): subscribe to an already-running chat turn
 * — the same URL page.tsx's attachAgentRunIfLive opens. NO message params: the
 * unified endpoint serves the live run's buffered ring + future events. The
 * coding streamUrl is the wrong endpoint for a plain chat (it 404s), which is
 * why every plain attach path (attachOnLoad / focus resync / drain attach /
 * error reconnect) must go through this builder.
 */
export function buildPlainAttachUrl(chatId: string): string {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  return `${apiBase}/crossmodel/chats/${chatId}/stream?${new URLSearchParams({ ...(token ? { token } : {}), _t: String(Date.now()) })}`;
}

/**
 * Liveness signal for a plain chat run (P2 increment 2): TRUE while any
 * process holds the chat's run slot (cross-process busy-state, PR #226) —
 * backs the focus re-attach and the post-complete drain attach. Same endpoint
 * page.tsx's attachAgentRunIfLive probes — and the same JWT discipline:
 * ensureFreshAuthCookie() FIRST, because the access token lives only 15 min
 * and a stale one 401s (page.tsx learnt this 2026-07-23: the 401 silently read
 * as "no active run" and every resume path fell through to a blank bubble).
 *
 * TRI-STATE: null = UNKNOWN (transient failure / no token / non-OK) — callers
 * must never treat it as "run ended" (resync would clear a live run's state);
 * only a 200 with active:false is a definitive FALSE. An aborted probe (P5
 * polling: signal cancelled by a newer tick/unmount) lands in the catch and
 * returns null — exactly the "leave it alone" semantics abort needs.
 */
export async function fetchPlainRunActive(chatId: string, signal?: AbortSignal): Promise<boolean | 'gone' | null> {
  await ensureFreshAuthCookie(); // no-op when fresh / anonymous
  const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  if (!token) return null;
  const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
  try {
    const r = await fetch(`${apiBase}/crossmodel/agent/active?chatId=${encodeURIComponent(chatId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
      signal,
    });
    // Owner 2026-10-27 (stale-delete UI report): the endpoint 404s when the
    // CHAT ROW is gone (deleted — controller returns 404 "Chat not found"
    // with no existence leak). That is terminal and un-retryable, not the
    // same as "unknown" — surface it as 'gone' so callers can land in the
    // deleted state instead of retrying a dead chat forever. Existing
    // callers' `=== true` / `=== false` checks are unaffected by the widened
    // union; only the reconnect/resync paths act on 'gone'.
    if (r.status === 404) return 'gone';
    if (!r.ok) return null;
    const j = await r.json();
    return !!j?.data?.active;
  } catch {
    return null;
  }
}


/**
 * Shape an agent-activity `detail` snippet into the args key the transcript's
 * toolSummary reads (owner 2026-09-15 — live tool rows showed bare verbs):
 * search-like tools → { query }, read/browse tools → { url }, delegation →
 * { subtask }, anything else keeps the generic { detail } (still expandable).
 */
export function toolArgsFromDetail(name: unknown, detail: unknown): Record<string, string> {
  const d = typeof detail === 'string' ? detail.trim() : '';
  if (!d) return {};
  const n = String(name ?? '');
  if (n === 'search_engine' || n === 'web_pipe' || n === 'search_memory' || n === 'grep' || n === 'search_code_semantic' || /_search$/.test(n) || /search/i.test(n)) return { query: d };
  if (n === 'scrape_as_markdown' || n === 'browser_task' || n.startsWith('scrape')) return { url: d };
  if (n === 'delegate' || n === 'spawn_subagent') return { title: d };
  return { detail: d };
}
