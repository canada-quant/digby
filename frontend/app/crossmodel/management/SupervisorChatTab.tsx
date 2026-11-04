'use client';

import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { DigbyLoader } from '@/components/ui/custom/DigbyLoader';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { toast } from 'sonner';
import { Paperclip, PanelRight, ArrowUp, Mic, MicOff, Loader2 } from 'lucide-react';
import { fleetApi, type FleetSupervisor, type FleetThreadMessage, type FleetThreadPage } from '@/lib/api/fleet';
import type { MessagePart } from '@/lib/api/coding';
import { ensureFreshAuthCookie } from '@/lib/api-client';
import { buildPlainAttachUrl, makeLegacyNormalizer } from '../plain-session';
import { mergeDeltaIntoParts } from '@/lib/reasoning-merge';
import { decideTranscriptPin } from '@/lib/transcript-pin';
import { AssistantParts } from '../components/code-transcript';
import ChatComposer, { COMPOSER_TOOL_BTN } from '../components/ChatComposer';
import type { ChatComposerHandle } from '../components/ChatComposerTextarea';
import { useVoiceComposer } from '../components/use-voice-composer';
import { AttachmentChips, uploadChatFiles, type AttachmentInfo } from '../components/attachments';
import { CodeTranscriptMarkdown } from '../components/code-transcript';
import type { PlainMessageMeta } from '@/lib/api/coding';
import { TranscriptAttachmentChips } from '@/components/ui/custom/prompt/transcript-attachment-chips';
import MachineWakeBlock from '../components/MachineWakeBlock';
import { MinimalNoteLine } from '../components/MinimalNoteLine';
import { useMinimalView, isMinimalHidden, minimalNoteLabel, groupMinimalNotes } from '@/lib/view-mode';
import MachineTurnGroup from '../components/MachineTurnGroup';
import MachineBundle from '../components/MachineBundle';
import MessageNavigator, { navPreview } from '../components/MessageNavigator';
import { classifySystemRow } from '@/lib/machine-wake';
import { bundleMachineGroups, groupMachineRows, type MachineTurnGroup as MachineTurnGroupItem } from '@/lib/machine-turn-grouping';
import { SupervisorOverviewPanel } from './SupervisorOverviewPanel';
import { cn } from '@/lib/utils';
import { shortTimestamp } from './utils';

const POLL_MS = 4_000;
/** Idle heartbeat — keeps the thread live after a run finishes (see startPolling). */
const IDLE_POLL_MS = 15_000;
const THREAD_PAGE = 50;
/** Live-region ring cap — CodeSessionView's MAX_LIVE_PARTS discipline. */
const MAX_LIVE_PARTS = 200;
/** Consecutive no-op (wrong-instance) attaches before SSE parks for the run —
 * mirrors page.tsx's agentAttachFailCount cap on the same no-affinity topology. */
const MAX_ATTACH_FAILS = 3;
/**
 * Run-attribution window for the status LABEL: a run first observed within
 * this long after the user's own send reads "Supervisor is working…";
 * anything else (a machine wake already in flight when the tab opened, a
 * schedule firing) reads "Working on a background task…". Label-only
 * heuristic — the live region streams either way.
 */
const USER_RUN_WINDOW_MS = 60_000;
/**
 * Attachment-only sends need SOME text for the pipeline (the bubble shows just
 * the chips — these placeholders are hidden at render time, matching
 * CodeSessionView's plain-mode echo).
 */
const IMAGE_PLACEHOLDER = 'Describe and analyze the attached image(s).';
const DOC_PLACEHOLDER = 'Analyze the attached file(s).';
const ATTACHMENT_PLACEHOLDERS = new Set([IMAGE_PLACEHOLDER, DOC_PLACEHOLDER]);
/**
 * Server-side message cap (ticket eb7a3919) — MUST match the backend's
 * fleet.validation.ts FLEET_MESSAGE_MAX_CHARS. Over-limit sends used to fail
 * only server-side with an opaque "Validation error" toast; now the composer
 * refuses up front with the length named, and a live character counter appears
 * once the draft approaches the limit.
 * 2026-09-12 (ticket df145eb3): 8,000 → 100,000 for HUMAN-typed messages
 * (matches the backend fleet cap raised in the same change).
 */
const MAX_SUPERVISOR_MESSAGE_CHARS = 100_000;
/** Show the live character counter from this length on. */
const NEAR_LIMIT_CHARS = MAX_SUPERVISOR_MESSAGE_CHARS - 10_000;

export function SupervisorChatTab({ onGoLogs, focusMessageId }: { onGoLogs: () => void; focusMessageId?: string }) {
  // Supervisor identity — auto-provisioned server-side (exactly ONE global
  // fleet supervisor per user; there is no manual designation step).
  const [supervisor, setSupervisor] = useState<FleetSupervisor | null>(null);
  const [loadingSupervisor, setLoadingSupervisor] = useState(true);
  const [supervisorError, setSupervisorError] = useState(false);

  // Minimal view (2026-10-16, lib/view-mode.ts): a user sees replies + one-line notes, never machine turns.
  const minimal = useMinimalView();
  // Thread state
  const [messages, setMessages] = useState<FleetThreadMessage[]>([]);
  // Optimistic sends the server transcript does not contain yet (a queued
  // message lives in pending_chat_messages, invisible to the thread endpoint
  // until the active run finishes) — rendered after `messages`.
  const [pending, setPending] = useState<FleetThreadMessage[]>([]);
  const [threadLoaded, setThreadLoaded] = useState(false);
  const [threadError, setThreadError] = useState(false);
  const [liveError, setLiveError] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [running, setRunning] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);
  // USER-typed subset of the queue (F3 — honest "your message is queued"
  // status; machine relay traffic sharing the queue never counts here).
  const [queuedUserCount, setQueuedUserCount] = useState(0);

  // Composer state — the draft lives INSIDE ChatComposerTextarea (typing must
  // not re-render this whole tab); the host tracks only empty↔non-empty flips
  // (hasText) for the send-button gate, and reads/clears via the handle.
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const [hasText, setHasText] = useState(false);
  const [sending, setSending] = useState(false);
  // Near-limit character counter (ticket eb7a3919): 0 while well under the
  // limit (no re-render per keystroke — the draft deliberately lives inside
  // ChatComposerTextarea); the exact length once the draft enters the warning
  // zone. Fed by a native input listener on the textarea below.
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [charCount, setCharCount] = useState(0);

  // Voice input (ticket 3dcb5b99): the shared hook, exactly as the main chat
  // (page.tsx) and coding sessions (CodeSessionView) use it — the mic renders
  // in EVERY composer (owner 2026-10-20, ceb6fe658); this tab was the one
  // surface still missing it. send() below calls discardRecording() so a
  // committed draft is never re-injected ("hitting send turns the mic off").
  const { isRecording, isTranscribing, toggleRecording: handleMicClick, discardRecording } = useVoiceComposer({ composerRef, textareaRef });

  // Attachments — the SHARED staging flow (../components/attachments), identical
  // to the main chat: paperclip / drop / paste → POST /crossmodel/upload →
  // chips bar; uploadIds ride the fleet send (backend resolves + attaches).
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // Overview panel (collapsible; defaults open on wide screens — decided in
  // an effect below so SSR and first client render agree).
  const [panelOpen, setPanelOpen] = useState(false);

  // Live run state — the supervisor is a plain detached chat, so its runs
  // register under chat:${chatId} and the unified /chats/:id/stream attach
  // endpoint replays + tails them. While the thread poll reports a run, an
  // EventSource streams it here: events accumulate into `liveParts`
  // (rendered via AssistantParts — the coding-session "what it is doing" UI)
  // plus a throttled status line. The thread itself stays server-filtered;
  // the finished reply lands in it via an immediate refetch on the terminal
  // event.
  const [liveParts, setLiveParts] = useState<MessagePart[]>([]);
  const [liveStatus, setLiveStatus] = useState('');
  const [backgroundRun, setBackgroundRun] = useState(false);

  const threadRef = useRef<HTMLDivElement>(null);
  // Inner content wrapper — the ResizeObserver watches THIS so markdown/image
  // growth (async layout after the state effects) still re-lands the pin.
  const threadContentRef = useRef<HTMLDivElement>(null);
  // Scroll discipline, ported from page.tsx's main chat (PR #100 lineage):
  // pinned starts true (a freshly opened thread lands on the newest message);
  // only a genuine UPWARD user scroll breaks the pin; landing near the bottom
  // re-pins. Never yank a reader who scrolled up.
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // "Load earlier" prepend restore: snapshot the viewport metrics SYNCHRONOUSLY
  // with the prepend's setState; the layout effect shifts scrollTop by exactly
  // the added height so the same message stays under the eye (Safari has no
  // native scroll anchoring).
  const prependScrollRef = useRef<{ height: number; top: number } | null>(null);
  const lastSigRef = useRef(''); // no-change guard for the always-on heartbeat
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Epoch token: startPolling bumps it, and any in-flight tick from a previous
  // chain sees a stale value and dies instead of re-arming — a send() landing
  // inside an in-flight fetch used to stack a second immortal chain.
  const pollGenRef = useRef(0);
  const mountedRef = useRef(true);
  // Synchronous mirrors of `messages`/`pending` — merge/prune logic runs from
  // async poll callbacks, where the state values in scope can be stale.
  const messagesRef = useRef<FleetThreadMessage[]>([]);
  const pendingRef = useRef<FleetThreadMessage[]>([]);
  // Oldest-known paging cursor, tracked together so hasMore stays consistent.
  const pagingRef = useRef<{ hasMore: boolean; nextBefore?: string }>({ hasMore: false });

  // ── Live streaming refs ───────────────────────────────────────────────────
  const esRef = useRef<EventSource | null>(null);
  // Stable per-part identity — keys must survive the MAX_LIVE_PARTS front-slice.
  const partSeqRef = useRef(0);
  // Status-line throttle: progress pulses can arrive several times a second.
  const statusAtRef = useRef(0);
  // Bumped on every close — an attach still awaiting ensureFreshAuthCookie
  // sees a stale generation and never opens.
  const attachGenRef = useRef(0);
  // Last successful composer send — drives the yours-vs-background label.
  const lastSendAtRef = useRef(0);
  // Cross-instance attach guard (reviewer-flagged): prod serves two no-affinity
  // instances and the run registry is process-local, so an attach that lands on
  // the wrong instance gets an immediate complete{interrupted:true} with zero
  // content events — and the terminal continuation + busy poll ticks used to
  // loop attach→complete→refetch→attach for the rest of the run. A pipe that
  // yields ANY real event proves the right instance and re-arms the budget;
  // after MAX_ATTACH_FAILS consecutive no-op attaches SSE parks for this run
  // and the 4s poll alone carries the reply (pre-streaming behavior). Re-armed
  // on the next run edge and on send.
  const attachFailCountRef = useRef(0);
  const gotStreamEventRef = useRef(false);
  const liveScrollRef = useRef<HTMLDivElement>(null);

  // ── Thread loading ──────────────────────────────────────────────────────────

  const setThreadMessages = useCallback((msgs: FleetThreadMessage[]) => {
    messagesRef.current = msgs;
    setMessages(msgs);
  }, []);

  const setPendingMessages = useCallback((msgs: FleetThreadMessage[]) => {
    pendingRef.current = msgs;
    setPending(msgs);
  }, []);

  /**
   * Adopt a page's paging cursor. A poll's latest-window cursor must never
   * clobber the deeper cursor from "Load earlier" prepends. Cursor ids are
   * random UUIDs (lexically meaningless), so depth is judged against the
   * merged thread: adopt only when the page's window reaches the oldest row
   * we hold (callers merge into messagesRef BEFORE calling this) — or when
   * the caller is walking backward (`force`).
   */
  const adoptPaging = useCallback((page: {
    hasMore: boolean; nextBefore?: string; messages: FleetThreadMessage[];
  }, force: boolean) => {
    if (!force) {
      const oldestKnown = messagesRef.current[0];
      if (oldestKnown && oldestKnown.id !== page.messages[0]?.id) return;
    }
    pagingRef.current = { hasMore: page.hasMore, nextBefore: page.nextBefore };
    setHasMore(page.hasMore);
    setNextBefore(page.nextBefore);
  }, []);

  const applyThreadPage = useCallback((page: {
    running: boolean; queuedCount: number; queuedUserCount?: number; messages: FleetThreadMessage[];
    hasMore: boolean; nextBefore?: string;
  }) => {
    // No-change guard: with the always-on heartbeat this otherwise re-rendered
    // (and re-pinned scroll) every 15s on an idle thread — yanking a user who
    // scrolled up to read.
    const last = page.messages[page.messages.length - 1];
    const sig = `${page.messages.length}|${last?.id ?? ''}|${page.running}|${page.queuedCount}|${page.queuedUserCount ?? 0}|${page.hasMore}`;
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    // Scroll: no pin bookkeeping here — pinnedRef starts true (first load lands
    // on the newest) and the thread's own scroll handler owns un/re-pinning.

    const prev = messagesRef.current;
    const prevIds = new Set(prev.map((m) => m.id));
    // MERGE, never replace: keep "Load earlier" prepends and rows that slid out
    // of the server's latest-page window; the page stays the source of truth
    // for the rows it covers (dedupe by id, order by createdAt).
    const pageIds = new Set(page.messages.map((m) => m.id));
    const merged = [...prev.filter((m) => !pageIds.has(m.id)), ...page.messages].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    setThreadMessages(merged);

    // Drop an optimistic bubble only once the transcript actually contains it:
    // each NEWLY-arrived user row claims one pending bubble with equal content
    // (matching only new rows keeps a repeat of an old message pending).
    const newUserContents = page.messages.filter((m) => !prevIds.has(m.id) && m.role === 'user');
    if (newUserContents.length > 0 && pendingRef.current.length > 0) {
      const counts = new Map<string, number>();
      for (const m of newUserContents) counts.set(m.content, (counts.get(m.content) ?? 0) + 1);
      const remaining = pendingRef.current.filter((p) => {
        const n = counts.get(p.content) ?? 0;
        if (n > 0) { counts.set(p.content, n - 1); return false; }
        return true;
      });
      if (remaining.length !== pendingRef.current.length) setPendingMessages(remaining);
    }

    adoptPaging(page, false);
    setRunning(page.running);
    setQueuedCount(page.queuedCount);
    // Additive (old backends omit it — deploy skew degrades to 0 = today's UI).
    setQueuedUserCount(page.queuedUserCount ?? 0);
    setThreadLoaded(true);
    setThreadError(false);
  }, [adoptPaging, setPendingMessages, setThreadMessages]);

  /** Fetch + merge the latest page into the thread. */
  const refreshThread = useCallback(async () => {
    const page = await fleetApi.getSupervisorThread({ limit: THREAD_PAGE, includeMachine: true });
    if (!mountedRef.current) return page;
    applyThreadPage(page);
    return page;
  }, [applyThreadPage]);

  // ── Live run streaming ────────────────────────────────────────────────────

  /** Close the attach pipe (terminal event, poll-says-idle, unmount, chat switch). */
  const closeLiveStream = useCallback(() => {
    attachGenRef.current += 1; // a pre-open attach still awaiting auth dies quietly
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  /**
   * Attach to the chat's live run over the unified SSE endpoint (replay of the
   * run's buffered ring, then live tail). No-op while a pipe is already open.
   * Auth is the exact page.tsx / CodeSessionView pattern: EventSource can't
   * set headers, so the JWT rides `?token=` (buildPlainAttachUrl) after
   * ensureFreshAuthCookie() re-issues the short-lived httpOnly cookie.
   *
   * The supervisor is a PLAIN chat run, so the stream speaks the legacy event
   * vocabulary (chunk / thinking-summary / agent-activity / progress…) —
   * makeLegacyNormalizer maps it onto MessageParts, same as CodeSessionView's
   * plain attach. progress never reaches the normalizer; it drives the status
   * line directly (throttled).
   */
  const attachLiveStream: (chatId: string) => void = useCallback((chatId: string) => {
    if (!chatId || esRef.current || !mountedRef.current) return;
    // Parked after repeated no-op (wrong-instance) attaches — the poll
    // heartbeat still delivers the reply; the cap re-arms on the next run
    // edge and on send.
    if (attachFailCountRef.current >= MAX_ATTACH_FAILS) return;
    const gen = attachGenRef.current;
    void (async () => {
      await ensureFreshAuthCookie(); // never rejects
      if (!mountedRef.current || gen !== attachGenRef.current || esRef.current) return;
      // Every (re)attach replays the run's whole buffered ring — clear the
      // accumulated parts first or re-attached deltas double up (the same
      // reset CodeSessionView does before its re-attach).
      setLiveParts([]);
      setLiveStatus('');
      gotStreamEventRef.current = false;
      const normalize = makeLegacyNormalizer();
      const es = new EventSource(buildPlainAttachUrl(chatId));
      esRef.current = es;

      const cap = (parts: MessagePart[]) =>
        parts.length > MAX_LIVE_PARTS ? parts.slice(parts.length - MAX_LIVE_PARTS) : parts;
      const stamp = (p: MessagePart): MessagePart => ({ ...p, uid: `lp${++partSeqRef.current}` });
      const appendDelta = (kind: 'text' | 'reasoning', delta: string, label?: string) => {
        if (!delta) return;
        // Per-label reasoning coalescing (owner report 2026-08-30) — see
        // lib/reasoning-merge.ts; same spam fix as CodeSessionView.
        setLiveParts((prev) => cap(mergeDeltaIntoParts(prev, kind, delta, { label, stamp })));
      };
      const pushPart = (p: MessagePart) => setLiveParts((prev) => cap([...prev, stamp(p)]));
      // subagent parts render as "Working…" until their end event lands.
      const markSubagentDone = (title?: string) => setLiveParts((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          const p = prev[i];
          if (p.type === 'subagent' && p.summary === 'Working…' && (!title || p.title === title)) {
            const parts = prev.slice();
            parts[i] = { ...p, summary: 'Done' };
            return parts;
          }
        }
        return prev;
      });

      es.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const { type, data } = msg;
        if (type === 'progress') {
          const message = String(data?.message ?? '').trim();
          // A real event proves this pipe reached the instance that owns the
          // run — re-arm the attach budget.
          if (message) { gotStreamEventRef.current = true; attachFailCountRef.current = 0; }
          if (message && Date.now() - statusAtRef.current > 300) {
            statusAtRef.current = Date.now();
            setLiveStatus((prev) => (prev === message ? prev : message));
          }
          return;
        }
        const n = normalize(type, data);
        if (!n) return; // housekeeping events with no part vocabulary equivalent
        // Content parts prove a live pipe (complete/error are judged separately
        // — a no-op attach's ONLY event is the terminal one).
        if (n.type !== 'complete' && n.type !== 'error') { gotStreamEventRef.current = true; attachFailCountRef.current = 0; }
        if (n.type === 'text') appendDelta('text', n.data.delta);
        else if (n.type === 'reasoning') appendDelta('reasoning', n.data.delta, n.data.label);
        else if (n.type === 'tool_call') pushPart({ type: 'tool_call', name: n.data.name, args: n.data.args, ...(typeof n.data.label === 'string' && n.data.label ? { label: n.data.label } : {}) });
        else if (n.type === 'tool_result') pushPart({ type: 'tool_result', name: n.data.name, result: n.data.result, ...(typeof n.data.label === 'string' && n.data.label ? { label: n.data.label } : {}) });
        else if (n.type === 'subagent_start') pushPart({ type: 'subagent', title: n.data.title || n.data.role || 'helper', summary: 'Working…' });
        else if (n.type === 'subagent_end') markSubagentDone(n.data.title || n.data.role);
        else if (n.type === 'complete' || n.type === 'error') {
          es.close();
          if (esRef.current === es) esRef.current = null;
          // No content before the terminal = the wrong-instance no-op
          // (complete{interrupted:true} from the no-affinity fallthrough).
          // Burn one attach budget so the continuation below (and the busy
          // poll ticks) can't loop attach→complete→refetch→attach for the
          // rest of the run — after MAX_ATTACH_FAILS the poll alone carries.
          if (!gotStreamEventRef.current) attachFailCountRef.current += 1;
          // The server-filtered reply lands via the thread endpoint — refetch
          // immediately and only THEN clear the live region (no blank-flicker,
          // no duplicate bubble). A queued message can drain straight into the
          // next turn: still busy → re-attach at once (the poll would, ~4s on).
          void (async () => {
            let page: FleetThreadPage | null = null;
            try { page = await refreshThread(); } catch { /* the poll loop re-tries */ }
            if (!mountedRef.current) return;
            // A poll tick may have beaten this continuation to the follow-up
            // run's pipe — it already cleared + owns the live region; touching
            // either here would wipe its freshly replayed parts.
            if (esRef.current) return;
            setLiveParts([]);
            setLiveStatus('');
            setBackgroundRun(false);
            if (page?.running) attachLiveStream(chatId);
          })();
        }
      };
      es.onerror = () => {
        // No retry storm: close and let the poll heartbeat carry the reply;
        // the next busy tick re-attaches (at most one attempt per tick, and
        // only while the no-op budget lasts — an error before ANY event is
        // indistinguishable from the wrong-instance topology failure).
        if (!gotStreamEventRef.current && esRef.current === es) attachFailCountRef.current += 1;
        es.close();
        if (esRef.current === es) esRef.current = null;
      };
    })();
  }, [refreshThread]);

  const stopPolling = useCallback(() => {
    pollGenRef.current += 1; // invalidate any in-flight tick chain
    if (pollTimerRef.current) { clearTimeout(pollTimerRef.current); pollTimerRef.current = null; }
  }, []);

  /**
   * Poll fast while a run is active or the queue drains, then drop to a slow
   * heartbeat — NEVER exit while mounted. A reply can land in the false-idle
   * gap between queue drain and run start (or minutes later, after a long
   * run); a poll that exits on idle never renders it, which read to the owner
   * as "the supervisor never responds". Ticks skip fetching while the browser
   * tab is hidden (the visibilitychange effect catches up on return).
   */
  const startPolling = useCallback(() => {
    stopPolling();
    const gen = pollGenRef.current;
    const tick = async () => {
      if (!mountedRef.current || gen !== pollGenRef.current) return; // superseded chain
      if (document.hidden) {
        pollTimerRef.current = setTimeout(tick, IDLE_POLL_MS);
        return;
      }
      try {
        const page = await refreshThread();
        if (!mountedRef.current || gen !== pollGenRef.current) return;
        setLiveError(false);
        // Real-time attach while a run is live (no-op once a pipe is open) —
        // the poll stays the heartbeat/fallback underneath the stream.
        if (page.running) attachLiveStream(page.chatId);
        const busy = page.running || page.queuedCount > 0;
        pollTimerRef.current = setTimeout(tick, busy ? POLL_MS : IDLE_POLL_MS);
      } catch {
        if (!mountedRef.current || gen !== pollGenRef.current) return;
        // Back off on errors but keep the heartbeat alive while mounted.
        setLiveError(true);
        pollTimerRef.current = setTimeout(tick, IDLE_POLL_MS);
      }
    };
    pollTimerRef.current = setTimeout(tick, POLL_MS);
  }, [refreshThread, stopPolling, attachLiveStream]);

  // ── Effects ─────────────────────────────────────────────────────────────────

  const loadSupervisor = useCallback(() => {
    setLoadingSupervisor(true);
    setSupervisorError(false);
    fleetApi.getSupervisor()
      .then((r) => {
        if (!mountedRef.current) return;
        setSupervisor(r.supervisor);
        setLoadingSupervisor(false);
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setSupervisorError(true); // honest error — distinct from "still provisioning"
        setLoadingSupervisor(false);
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadSupervisor();
    return () => { mountedRef.current = false; stopPolling(); closeLiveStream(); };
  }, [loadSupervisor, stopPolling, closeLiveStream]);

  // Wide screens default the overview panel open (CodeSessionView's pattern);
  // false initial state keeps SSR and first client render identical.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth >= 1024) setPanelOpen(true);
  }, []);

  // Live draft-length tracking for the near-limit counter (ticket eb7a3919)
  // WITHOUT re-rendering the tab on every keystroke: a native input listener
  // only produces a state CHANGE inside the warning zone (or when leaving it —
  // React bails out on identical values). Programmatic setValue/clear don't
  // fire 'input'; send() resets the counter explicitly after clearing.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onInput = () => {
      const len = el.value.length;
      setCharCount(len >= NEAR_LIMIT_CHARS ? len : 0);
    };
    el.addEventListener('input', onInput);
    return () => el.removeEventListener('input', onInput);
  }, [supervisor?.id, loadingSupervisor]);

  // The supervisor identity is a singleton, but a re-provision swaps the chat
  // id — the live pipe + accumulated parts belong to the old chat.
  useEffect(() => {
    closeLiveStream();
    setLiveParts([]);
    setLiveStatus('');
    setBackgroundRun(false);
  }, [supervisor?.id, closeLiveStream]);

  // Run attribution, edge-triggered on `running` so a mid-run send doesn't
  // relabel the in-flight turn: false→true decides yours-vs-background from
  // lastSendAt; true→false clears any live state the stream didn't (e.g. the
  // terminal event raced a hidden-tab poll — the reply is already in the
  // freshly-polled thread).
  const runningRef = useRef(false);
  useEffect(() => {
    const was = runningRef.current;
    runningRef.current = running;
    if (running && !was) {
      setBackgroundRun(!lastSendAtRef.current || Date.now() - lastSendAtRef.current > USER_RUN_WINDOW_MS);
      attachFailCountRef.current = 0; // new run → fresh attach budget
    } else if (!running && was) {
      closeLiveStream();
      setLiveParts([]);
      setLiveStatus('');
      setBackgroundRun(false);
    }
  }, [running, closeLiveStream]);

  // Initial thread load — also the "Retry" action after a failed load (a
  // failed first load must not render a success-looking empty thread).
  const loadThread = useCallback(async () => {
    setThreadError(false);
    try {
      let page = await fleetApi.getSupervisorThread({ limit: THREAD_PAGE, includeMachine: true });
      // Never render an EMPTY page that still has history behind it as a fake
      // empty thread (owner report 2026-08-15: "i see no messages"). The
      // backend now scans past all-noise windows itself, but deploy skew /
      // its hard cap can still return one — follow the cursor a bounded few
      // hops before believing the thread is really empty.
      for (let hop = 0; hop < 6 && page.messages.length === 0 && page.hasMore && page.nextBefore; hop++) {
        if (!mountedRef.current) return;
        page = await fleetApi.getSupervisorThread({ before: page.nextBefore, limit: THREAD_PAGE, includeMachine: true });
      }
      if (!mountedRef.current) return;
      applyThreadPage(page);
      startPolling(); // always-on: fast while busy, 15s heartbeat when idle
    } catch {
      if (!mountedRef.current) return;
      setThreadError(true);
    }
  }, [applyThreadPage, startPolling]);

  // Load the thread once the supervisor identity is known.
  useEffect(() => {
    if (!supervisor) return;
    loadThread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supervisor?.id]);

  // Catch up immediately when the tab becomes visible again (ticks skip
  // fetching while hidden), then resume the normal loop.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden || !pollTimerRef.current) return;
      refreshThread().catch(() => {});
      startPolling();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refreshThread, startPolling]);

  // ── Scroll discipline (ported from page.tsx's main chat) ──────────────────

  // Same pure rule as CodeSessionView (lib/transcript-pin.ts, owner recording
  // 2026-09-18): an upward move unpins at once instead of being re-pinned by
  // the 80px near-bottom band while the gesture is still in progress; downward
  // moves far from the bottom (anchoring bumps, programmatic scrolls) still
  // never change the pin (PR #100).
  const upGestureUntilRef = useRef(0);
  const onThreadScroll = useCallback(() => {
    const el = threadRef.current;
    if (!el) return;
    const { next } = decideTranscriptPin(
      { pinned: pinnedRef.current, lastTop: lastScrollTopRef.current, upGestureUntil: upGestureUntilRef.current },
      { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, now: Date.now() },
    );
    pinnedRef.current = next.pinned;
    lastScrollTopRef.current = next.lastTop;
    upGestureUntilRef.current = next.upGestureUntil;
  }, []);

  // Pinned-only autoscroll + stick: keep the view glued to the newest content
  // through async growth (markdown render, image loads) via a ResizeObserver on
  // the CONTENT (heights change without any state update) — instant scrolls,
  // and only while pinned, so a reader who scrolled up is never yanked down.
  useEffect(() => {
    const vp = threadRef.current;
    const content = threadContentRef.current;
    if (!vp || !content) return;
    const stick = () => { if (pinnedRef.current) vp.scrollTo({ top: vp.scrollHeight }); };
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(stick);
      ro.observe(content);
      ro.observe(vp);
    }
    stick(); // first load lands on the newest message (pinned starts true)
    return () => ro?.disconnect();
  }, [threadLoaded]);

  // New messages/pending bubbles: scroll to bottom while pinned (the RO above
  // covers later async growth; this lands the initial jump).
  useEffect(() => {
    const el = threadRef.current;
    if (el && pinnedRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [messages, pending]);

  // "Load earlier" prepend restore — useLayoutEffect, NOT useEffect: the shift
  // must land before the browser paints the prepended frame (Safari/iOS have no
  // native scroll anchoring; a passive effect visibly jumps). One-shot: armed
  // synchronously with the prepend, consumed by the commit that contains it.
  useLayoutEffect(() => {
    const snap = prependScrollRef.current;
    if (!snap) return;
    prependScrollRef.current = null;
    const vp = threadRef.current;
    if (vp) vp.scrollTo({ top: snap.top + (vp.scrollHeight - snap.height) });
  }, [messages]);

  // The live region is transient and small — always pin it to the newest
  // activity (the thread above keeps its own scroll discipline).
  useEffect(() => {
    const el = liveScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveParts, liveStatus]);

  // ── Thread actions ──────────────────────────────────────────────────────────

  const loadEarlier = async () => {
    if (!nextBefore || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await fleetApi.getSupervisorThread({ before: nextBefore, limit: THREAD_PAGE, includeMachine: true });
      if (!mountedRef.current) return;
      const prev = messagesRef.current;
      const prevIds = new Set(prev.map((m) => m.id));
      const older = page.messages.filter((m) => !prevIds.has(m.id));
      // Snapshot BEFORE the prepend lands — the layout effect restores the
      // exact reading position (see prependScrollRef).
      const el = threadRef.current;
      if (el) prependScrollRef.current = { height: el.scrollHeight, top: el.scrollTop };
      setThreadMessages([...older, ...prev]); // PREPEND older page
      adoptPaging(page, true); // walking backward — always adopt the deeper cursor
    } catch {
      toast.error('Could not load earlier messages.');
    } finally {
      if (mountedRef.current) setLoadingEarlier(false);
    }
  };

  /** Shared upload entry for the paperclip picker, drag-and-drop, and paste.
   *  Never rejects (callers clear the file input in .finally). */
  const attachFiles = useCallback(async (files: File[]) => {
    if (!files.length) return;
    let staged: AttachmentInfo[] = [];
    try {
      staged = await uploadChatFiles(files, { onBytesReady: () => setUploading(true) });
    } catch {
      staged = []; // uploadChatFiles toasts per-file; this is belt-and-braces
    } finally {
      setUploading(false);
    }
    if (staged.length) setAttachments((prev) => [...prev, ...staged]);
  }, []);

  /** Mobile jump-to-your-message (owner report 2026-09-03): the tick rail's
   *  2px bars are effectively invisible/untappable on a phone — the floating
   *  button scrolls the latest owner row (data-nav-msg) into view. */
  const jumpToLastOwnerMessage = useCallback(() => {
    const root = threadContentRef.current;
    if (!root) return;
    const rows = root.querySelectorAll('[data-nav-msg]');
    const last = rows[rows.length - 1] as HTMLElement | undefined;
    last?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const send = async () => {
    const typed = (composerRef.current?.getValue() ?? '').trim();
    if ((!typed && attachments.length === 0) || sending) return;
    // Busy + attachments are SUPPORTED (ac65d51e): the staged uploadIds ride
    // pending_chat_messages with their Redis TTL stretched to 24h, and the
    // queue drain resolves them into the run. (The old "queued messages can't
    // carry attachments" refusal here WAS the attachments-stuck-queued bug —
    // owner regression report 2026-09-03: on this hourly-busy chat the block
    // refused nearly every attachment send until the 15-min blobs expired.)
    // Snapshot + clear the bar NOW (legacy send semantics: the echo bubble
    // shows the chips, the bar empties, a failed send keeps neither guessing).
    const atts = attachments;
    const uploadIds = atts.map((a) => a.uploadId);
    // Attachment-only send: the pipeline needs SOME text to work with; the
    // bubble shows just the chips, not the placeholder.
    const content = typed || (atts.some((a) => a.type === 'image') ? IMAGE_PLACEHOLDER : DOC_PLACEHOLDER);
    // Pre-send length gate (ticket eb7a3919): the backend caps content at
    // 8,000 chars — refuse HERE with the length named instead of letting the
    // server reply with a validation error. The draft + attachments stay put.
    if (content.length > MAX_SUPERVISOR_MESSAGE_CHARS) {
      toast.error(
        `Message is ${content.length.toLocaleString()} characters — the supervisor chat accepts at most ${MAX_SUPERVISOR_MESSAGE_CHARS.toLocaleString()}. Trim it or split it into parts.`,
      );
      return;
    }
    // Voice (3dcb5b99): mic auto-off ATOMIC with the send — abort BEFORE the
    // network await (CodeSessionView review M1 round 2 doctrine: discarding
    // only after the await left recognition live during the POST, so trailing
    // speech re-wrote the just-cleared composer and survived).
    discardRecording();
    setSending(true);
    try {
      const result = await fleetApi.sendSupervisorMessage(content, uploadIds);
      if (!mountedRef.current) return;
      composerRef.current?.clear();
      setCharCount(0); // programmatic clear fires no 'input' event
      setAttachments([]);
      // Run attribution for the status label (see the `running` edge effect).
      lastSendAtRef.current = Date.now();
      attachFailCountRef.current = 0; // the user's own run gets a fresh attach budget
      // Optimistic bubble — kept in `pending` (NOT the server-truth list) until
      // a poll shows the transcript actually contains it; a queued send is
      // invisible to the thread endpoint until the active run finishes.
      setPendingMessages([...pendingRef.current, {
        id: `optimistic-${Date.now()}`,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        origin: 'user',
        ...(atts.length
          ? { attachments: atts.map((a) => ({ filename: a.filename, type: a.type, localPreview: a.localPreview })) }
          : {}),
      }]);
      pinnedRef.current = true;
      if (result.queued) {
        setQueuedCount((q) => Math.max(q, result.position ?? q + 1));
        // Optimistic: the next thread poll reconciles with the server count.
        setQueuedUserCount((q) => q + 1);
        toast.info(result.position != null
          ? `Queued — the supervisor is busy (position ${result.position})`
          : 'Queued — the supervisor is busy');
      } else {
        setRunning(true);
        // Attach NOW — the detached run registered server-side before this
        // response arrived, so the stream replays from the turn's start
        // instead of waiting up to one poll tick.
        attachLiveStream(supervisor?.id ?? '');
      }
      startPolling();
    } catch (err: any) {
      if (!mountedRef.current) return;
      // Surface the server's reason when one exists (notably the busy +
      // attachments 409) — the bar + draft stay intact so the user can retry.
      // Zod failures render as { error: 'Validation error', details: [...] }
      // (middleware/error-handler.ts): the first issue's message is the human
      // text (e.g. the 8,000-char limit) — never show the opaque envelope
      // label when a real reason exists (ticket eb7a3919).
      toast.error(
        err?.response?.data?.details?.[0]?.message
        || err?.response?.data?.error
        || err?.message
        || 'Failed to send.',
      );
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  // Grouping hoisted ABOVE the early returns (rules-of-hooks; Issue 7): shared
  // by the render AND the dashboard Fleet-summary click-through — the target
  // wake's group mounts expanded (defaultExpanded) and the tab scrolls its
  // final note row into view. thread is memoized so groupedThread's deps are
  // stable across renders.
  const thread = useMemo(
    () => [...(minimal ? messages.filter(m => !isMinimalHidden((m as any).minimal ? { minimal: (m as any).minimal } : undefined)) : messages), ...pending],
    [messages, pending, minimal],
  );
  const groupedThread = useMemo(() => groupMachineRows(thread, {
    probe: (m) => ({ id: m.id, role: m.role, content: m.content, origin: m.origin, kind: m.kind,
      // Ticket 56d6b204: a child→parent result-hook wake — the anchor row's
      // metadata.childResult (fleet.service flattens it onto the thread
      // message) mounts the turn EXPANDED so the sub-session's delivered
      // result is never hidden behind the collapsed machine pill.
      childResult: m.childResult === true,
      // Fixer 2026-09-27 (finding upward-chatter-1): an owner-ask re-wake /
      // nudge (fleet.service flattens metadata.ownerAskReply) mounts the turn
      // EXPANDED so the answer the owner asked for is never folded away.
      ownerAskReply: m.ownerAskReply === true,
      // Ticket 390b6767: an attachment chip with a resolved fileId (image
      // type or mime) renders inline — the group must not fold it away.
      carriesImage: !!m.attachments?.some(a => !!a.fileId && (a.type === 'image' || (a.mimeType || '').startsWith('image/'))) }),
    timeOf: (m) => shortTimestamp(m.createdAt),
  }), [thread]);
  const focusedGroupKey = focusMessageId
    ? groupedThread.find(
        (i): i is MachineTurnGroupItem<FleetThreadMessage> =>
          i.kind === 'machineGroup' && i.rows.some((r) => r.id === focusMessageId),
      )?.key
    : undefined;
  useEffect(() => {
    if (!focusMessageId) return;
    const t = window.setTimeout(() => {
      document
        .querySelector(`[data-msg-id="${focusMessageId}"]`)
        ?.scrollIntoView({ block: 'center' });
    }, 120);
    return () => window.clearTimeout(t);
  }, [focusMessageId, groupedThread]);

  // B1 (f3256715 adversarial review): the Fleet-summary card's "Open wake"
  // can now target a note several pages BACK — the no-op fallback scans up to
  // 10 pages for the last substantive note (~25 consecutive no-op wakes ≈ a
  // quiet day at the hourly cadence pushes it out of page 1). The focus
  // lookup above only sees the LOADED window, so auto-page backward (bounded,
  // one attempt per target) until the target is loaded — otherwise the
  // click-through silently no-ops.
  const focusPagingRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusMessageId) return;
    if (messages.some((m) => m.id === focusMessageId)) return;
    if (!hasMore || !nextBefore) return;
    if (focusPagingRef.current === focusMessageId) return; // one attempt per target
    focusPagingRef.current = focusMessageId;
    let cancelled = false;
    (async () => {
      let before: string | undefined = nextBefore;
      for (let hop = 0; hop < 10 && before && !cancelled; hop++) {
        try {
          const page = await fleetApi.getSupervisorThread({ before, limit: THREAD_PAGE, includeMachine: true });
          if (cancelled || !mountedRef.current) return;
          const prev = messagesRef.current;
          const prevIds = new Set(prev.map((m) => m.id));
          const older = page.messages.filter((m) => !prevIds.has(m.id));
          // No prependScrollRef snapshot: the focus scroll effect owns the
          // viewport for this flow — it scrolls the target into view once the
          // prepend lands in groupedThread.
          setThreadMessages([...older, ...prev]);
          adoptPaging(page, true);
          if (page.messages.some((m) => m.id === focusMessageId)) return;
          before = page.hasMore ? page.nextBefore : undefined;
        } catch {
          return; // a paging failure degrades to the old silent no-op — never toasts over a click-through
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMessageId, messages, hasMore, nextBefore]);

  if (loadingSupervisor) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  // The identity call FAILED — an honest error, not the provisioning state.
  if (!supervisor && supervisorError) {
    return (
      <LoadErrorState
        message="Could not load your fleet supervisor."
        onRetry={loadSupervisor}
        className="py-12"
      />
    );
  }

  // Not provisioned yet — the supervisor is created automatically (sidebar load /
  // first fleet call); this state should only ever be transient.
  if (!supervisor) {
    return (
      <div className="py-12 text-center space-y-3">
        <p className="text-sm text-muted-foreground">
          Your fleet supervisor is being set up — it provisions automatically.
        </p>
        <Button size="sm" variant="outline" onClick={loadSupervisor}>Retry</Button>
      </div>
    );
  }

  // thread/groupedThread/focusedGroupKey + the focus effect live ABOVE the
  // early returns (rules-of-hooks) — the render just consumes them here.

  // Chat column (status row + thread + live region + composer) beside the
  // collapsible overview panel: side-by-side on lg+, panel stacked above the
  // thread on mobile (panel-first DOM order + lg:order classes). flex-1/min-h-0
  // on the chat column keeps the thread filling the viewport (the page wrapper
  // is a min-h-full flex column) instead of a hardcoded dvh offset that pushed
  // the composer below the fold on short viewports.
  return (
    <div className="flex flex-1 min-h-0 flex-col gap-4 lg:flex-row">
      {panelOpen && (
        /* Mobile cap: the tab is height-constrained now (the thread owns the
           scroll), so an uncapped rail would squash the chat column; on lg+ it
           fills the column height and scrolls itself. */
        <div className="shrink-0 max-h-[45dvh] overflow-y-auto lg:max-h-none lg:order-2 lg:w-80 xl:w-96 lg:min-h-0">
          <SupervisorOverviewPanel running={running} queuedCount={queuedCount} queuedUserCount={queuedUserCount} onGoLogs={onGoLogs} />
        </div>
      )}

      <div className="flex flex-1 min-h-0 min-w-0 flex-col gap-3 lg:order-1">
      {/* Status row */}
      <div className="flex flex-wrap items-center gap-2 shrink-0">
        <span className="text-sm font-medium truncate max-w-[240px]">{supervisor.title}</span>
        {running
          ? <Badge variant="success" className="text-[10px]">Running</Badge>
          : queuedUserCount > 0
            // F3 (incident 2026-09-04): never label the chat "Idle" while the
            // owner's own message sits in the queue.
            ? <Badge variant="warning" className="text-[10px]">Queued</Badge>
            : <Badge variant="secondary" className="text-[10px]">Idle</Badge>}
        {queuedCount > 0 && <Badge variant="warning" className="text-[10px]">{queuedCount} queued</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            aria-pressed={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            <PanelRight className="size-3.5 mr-1" />
            Overview
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onGoLogs}>
            View logs
          </Button>
        </div>
      </div>

      {liveError && threadLoaded && (
        <p className="text-[11px] text-destructive shrink-0">
          Live updates are failing — showing the last loaded messages, retrying…
        </p>
      )}

      {/* Thread — the ONLY scroller in this tab (the page wrapper height-
          constrains the column, so this div's own overflow engages; before
          that, the window scrolled and "auto-scroll to newest" was a no-op
          against a non-overflowing container). Wrapped in a relative box so
          the right-edge MessageNavigator tick rail (the main chat's
          jump-to-your-message control) overlays the scroller. */}
      <div className="relative flex flex-1 min-h-[160px] min-w-0 flex-col">
      <div ref={threadRef} onScroll={onThreadScroll} className="flex-1 min-h-0 overflow-y-auto rounded-md border border-border bg-muted/20 px-3 py-3">
        <div ref={threadContentRef}>
        {/* Defensive: only render when a usable cursor exists (an all-noise
            page CAN report hasMore with an empty messages window). */}
        {hasMore && nextBefore && (
          <div className="text-center mb-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground"
              disabled={loadingEarlier}
              onClick={loadEarlier}
            >
              {loadingEarlier
                ? <span className="flex items-center gap-1.5"><Spinner className="size-3" />Loading…</span>
                : 'Load earlier'}
            </Button>
          </div>
        )}
        {!threadLoaded && threadError ? (
          <LoadErrorState
            message="Could not load the conversation — your history is safe, but it cannot be shown right now."
            onRetry={loadThread}
          />
        ) : !threadLoaded ? (
          <div className="flex items-center justify-center py-10">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : thread.length === 0 ? (
          <div className="text-center py-10 space-y-2">
            <p className="text-xs text-muted-foreground">
              {hasMore
                // Reachable only past the backend's deep-scan + this tab's own
                // follow hops — say what's true instead of "No messages yet".
                ? 'Only machine traffic in the recent window — your earlier conversation is behind “Load earlier” above.'
                : 'No messages yet — say hello to your supervisor below.'}
            </p>
            <p className="text-xs text-muted-foreground">
              Machine turns (sweeps, hook wakes, agent traffic) also render inline here; the raw merged log lives in{' '}
              <button type="button" className="underline hover:text-foreground" onClick={onGoLogs}>Logs</button>.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {(() => {
              // Machine-turn grouping (platform task, owner report 2026-09-02):
              // consecutive machine rows — wakes/relays/system notices plus the
              // assistant replies they produced — collapse into ONE accordion
              // group (see lib/machine-turn-grouping.ts). Human rows never
              // enter a group (collapse, never filter).
              const renderThreadRow = (m: FleetThreadMessage) => {
              const minimalNote = minimalNoteLabel((m as any).minimal ? { minimal: (m as any).minimal } : undefined);
              if (minimalNote) return <MinimalNoteLine key={m.id} text={minimalNote} />;
              // Machine/system traffic (schedule/hook/webhook wakes, inter-agent
              // relays, verifier/watchdog notices) collapses to a one-line
              // expandable system row — feedback 4959bb1c, the supervisor-tab
              // arm of Phase C. 'user'/unknown origins stay the owner's violet
              // bubble, always visible (collapse, never filter).
              const sysKind = m.role === 'user'
                ? classifySystemRow({ role: m.role, content: m.content, metadata: { origin: m.origin } })
                : null;
              return (
              // data-nav-msg/data-nav-preview on OWNER rows feed the right-edge
              // MessageNavigator tick rail (same control the main chat has).
              <div key={m.id}
                id={`msg-${m.id}`}
                data-msg-id={m.id}
                {...(m.role === 'user' && !sysKind ? { 'data-nav-msg': m.id, 'data-nav-preview': navPreview(m.content) || '(attachment)' } : {})}
                className={cn('flex', m.role === 'user' && !sysKind ? 'justify-end' : 'justify-start')}>
                {sysKind ? (
                  <MachineWakeBlock kind={sysKind} origin={m.origin} content={m.content} timeLabel={shortTimestamp(m.createdAt)} />
                ) : m.role === 'user' ? (
                  /* User — the main chat's violet bubble, with attachment chips
                     (the placeholder text of an attachment-only send stays
                     hidden, matching CodeSessionView's echo). c6e8edda: chips
                     carrying a fileId render the image INLINE (click-to-expand)
                     via the shared TranscriptAttachmentChips. */
                  <div className="max-w-[85%] rounded-2xl px-3.5 py-2 text-sm bg-bubble text-ink">
                    {m.attachments?.length ? (
                      <TranscriptAttachmentChips
                        attachments={m.attachments}
                        variant="overlay"
                        className="flex flex-wrap gap-1.5 mb-1"
                      />
                    ) : null}
                    {m.content && !(m.attachments?.length && ATTACHMENT_PLACEHOLDERS.has(m.content)) && (
                      <span className="whitespace-pre-wrap break-words">{m.content}</span>
                    )}
                    <div className="text-[10px] mt-1 text-ink-2 text-right">{shortTimestamp(m.createdAt)}</div>
                  </div>
                ) : (
                  /* Assistant — the main chat's shared assistant-body renderer
                     (owner 2026-09-14 screenshots): '[Owner inbox]' rows become
                     the OwnerInboxCard, harness chrome (claims fence, auto-verify,
                     evidence guard, 🔍 verification footers) folds into ONE
                     collapsed VerificationFooter, everything else is the same
                     MarkdownContent as before — never raw text. */
                  <div className="min-w-0 flex-1 text-sm">
                    <CodeTranscriptMarkdown
                      text={m.content}
                      meta={{ origin: m.origin, kind: m.kind } as unknown as PlainMessageMeta}
                      localizeTimes
                    />
                    <div className="text-[10px] mt-1 text-muted-foreground">{shortTimestamp(m.createdAt)}</div>
                  </div>
                )}
              </div>
              );
              };
              const renderGroup = (item: MachineTurnGroupItem<FleetThreadMessage>) => (
                <MachineTurnGroup key={item.key} count={item.count} summary={item.summary} headline={item.headline} timeLabel={item.timeLabel}
                  defaultExpanded={item.key === focusedGroupKey} groupKey={item.key}
                  // Ticket 56d6b204: a child→parent result-hook wake mounts
                  // EXPANDED + "results" chip — the sub-session's delivered
                  // verdict is content the owner is waiting on, never noise
                  // to fold behind the collapsed pill.
                  childResult={item.childResult}
                  // Fixer 2026-09-27: an owner-ask wake mounts EXPANDED +
                  // "answer" chip — the reply the owner asked for.
                  ownerAskReply={item.ownerAskReply}
                  // Ticket 390b6767: a delivered inline image mounts the group
                  // expanded + "image" chip — never folded out of sight.
                  hasImage={item.hasImage}>
                  {item.rows.map(r => renderThreadRow(r))}
                </MachineTurnGroup>
              );
              // Owner 2026-09-29 ("hide a lot more machine messages"):
              // consecutive background wakes fold into ONE row; the bundle
              // holding the dashboard click-through target mounts expanded.
              // Minimal view: the server already removed machine turns — every remaining row renders as itself,
              // except a stretch of "Message from …" notes, which is ONE line (owner 2026-10-21).
              if (minimal) {
                return groupMinimalNotes(thread, m => ((m as any).minimal ? { minimal: (m as any).minimal } : undefined), m => m.id)
                  .map(item => item.kind === 'notes'
                    ? <MinimalNoteLine key={item.key} text={item.text} title={item.title} />
                    : <div key={item.row.id}>{renderThreadRow(item.row)}</div>);
              }
              return bundleMachineGroups(groupedThread).map(item => item.kind === 'machineBundle' ? (
                <MachineBundle key={item.key} groups={item.groups.length} firstTime={item.firstTime} lastTime={item.lastTime} attention={item.attention} agentMessages={item.agentMessages} latest={item.latest}
                  defaultExpanded={item.groups.some(g => g.key === focusedGroupKey)}>
                  {item.groups.map(g => renderGroup(g))}
                </MachineBundle>
              ) : item.kind === 'machineGroup' ? renderGroup(item) : renderThreadRow(item.row));
            })()}
          </div>
        )}
        </div>
        {/* Live run — INLINE at the end of the message flow (owner report
            2026-09-03: as a shrink-0 sibling OUTSIDE the scroller this pinned
            a sticky panel that ate up to half the chat viewport while the
            hourly run streamed thinking). It now scrolls with the thread and
            never shrinks the viewport; on completion the parts collapse to
            the one-line status indicator until the reply lands in the thread. */}
        {(running || liveParts.length > 0) && (
          <div className="mt-3 rounded-md border border-brand-border/70 bg-brand-soft/50 px-3 py-2 dark:border-brand-border/40 dark:bg-brand-deep/20">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <DigbyLoader size={24} label="Supervisor is working" />
              <span className="truncate">
                {liveStatus || (backgroundRun ? 'Working on a background task…' : running ? 'Supervisor is working…' : 'Finishing up…')}
              </span>
            </div>
            {running && liveParts.length > 0 && (
              <div ref={liveScrollRef} className="mt-1.5 max-h-64 overflow-y-auto pr-1">
                <AssistantParts parts={liveParts} />
              </div>
            )}
          </div>
        )}
      </div>
      {/* Right-edge tick rail over the owner rows (data-nav-msg stamped
          above) — the jump-to-your-message control the main chat has. */}
      <MessageNavigator scrollerRef={threadRef} contentRef={threadContentRef} />
      {/* Mobile jump-to-your-message (owner report 2026-09-03: the rail's
          2px ticks are effectively invisible/untappable on a phone) — a real
          button, mobile only, scrolling your latest message into view. */}
      <button
        type="button"
        onClick={jumpToLastOwnerMessage}
        className="absolute bottom-3 right-3 z-30 flex h-9 items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 text-[11px] font-medium shadow-md md:hidden"
      >
        <ArrowUp className="size-3.5" /> Your last message
      </button>
      </div>

      {/* Queued indicator (F3, incident 2026-09-04): the owner's own message
          is waiting in the queue — say so at the composer instead of leaving
          the area silent under an "Idle" status. Subtle one-liner; the Status
          card carries the full copy. */}
      {queuedUserCount > 0 && (
        <p aria-live="polite" className="shrink-0 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Spinner className="size-3" />
          {queuedUserCount === 1 ? 'Your message is queued' : `${queuedUserCount} of your messages are queued`}
          {running ? ' — running as soon as the current run finishes.' : ' — starting now…'}
        </p>
      )}
      {/* Composer — the SHARED chat composer (variant="chat", the main chat's
          exact shell): paperclip attach + drag-and-drop + paste, chips bar in
          topContent; desktop Enter / ⌘/Ctrl+Enter / the send button submits
          (touch: Enter = newline, button sends — ticket 67fc53a7). The paperclip is
          NEVER disabled (a disabled button swallows the click AND its tooltip
          on Chromium — the 2026-08-09 dead-paperclip report); the spinner is
          purely visual. */}
      <div className="shrink-0">
        <ChatComposer
          variant="chat"
          composerRef={composerRef}
          textareaRef={textareaRef}
          onSubmit={() => { void send(); }}
          onEmptyChange={(empty) => setHasText(!empty)}
          onPaste={(e) => {
            // Paste-to-attach, images only (parity with the main chat).
            const imgs = Array.from(e.clipboardData?.items || []).filter((it) => it.type.startsWith('image/'));
            if (!imgs.length) return;
            e.preventDefault();
            void attachFiles(imgs.map((it) => it.getAsFile()).filter((f): f is File => !!f));
          }}
          canSubmit={(hasText || attachments.length > 0) && !sending && !uploading}
          submitPending={sending}
          placeholder={isRecording ? '🎤 Listening… speak now' : dragOver ? '📎 Drop files to attach…' : 'Message your fleet supervisor…'}
          submitTitle="Send"
          dragOver={dragOver}
          dragHandlers={{
            onDragOver: (e) => { e.preventDefault(); setDragOver(true); },
            onDragEnter: (e) => { e.preventDefault(); setDragOver(true); },
            onDragLeave: () => setDragOver(false),
            onDrop: (e) => {
              e.preventDefault(); e.stopPropagation();
              setDragOver(false);
              if (e.dataTransfer.files.length) void attachFiles(Array.from(e.dataTransfer.files));
            },
          }}
          topContent={attachments.length > 0 ? (
            <AttachmentChips attachments={attachments} onRemove={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))} />
          ) : undefined}
          footerNote={charCount >= NEAR_LIMIT_CHARS ? (
            /* Live counter once the draft nears the 8,000-char server cap
               (ticket eb7a3919) — red + explicit once it is over. */
            <p
              aria-live="polite"
              className={cn(
                'mt-1 text-right text-[11px] tabular-nums',
                charCount > MAX_SUPERVISOR_MESSAGE_CHARS ? 'text-destructive font-medium' : 'text-muted-foreground',
              )}
            >
              {charCount.toLocaleString()} / {MAX_SUPERVISOR_MESSAGE_CHARS.toLocaleString()} characters
              {charCount > MAX_SUPERVISOR_MESSAGE_CHARS ? ' — too long to send' : ''}
            </p>
          ) : undefined}
          leftActions={(
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                'size-8 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 flex items-center justify-center rounded-full transition-colors touch-manipulation',
                'text-muted-foreground hover:text-foreground hover:bg-muted',
                attachments.length > 0 && 'text-brand-text'
              )}
              title="Attach files"
              aria-label="Attach files"
            >
              {uploading ? <Spinner className="size-4" /> : <Paperclip className="size-4" />}
            </button>
          )}
          rightActions={(<>
            {/* Mic — voice input (3dcb5b99): same shared hook + pattern as the
                main chat (page.tsx) and coding sessions (CodeSessionView).
                Rendered in EVERY host, the desktop shell included (2026-10-20
                owner: one composer UI — chats, coding sessions AND the
                supervisor chat; in the shell the tap goes to the native
                recorder over the dictation bridge). A 34px ghost circle on
                the right, before Send. */}
            <button
              type="button"
              className={cn(
                COMPOSER_TOOL_BTN,
                isRecording && 'text-destructive bg-destructive/10 dark:bg-destructive/15 animate-pulse',
              )}
              onClick={handleMicClick}
              disabled={isTranscribing}
              title={isTranscribing ? 'Transcribing…' : isRecording ? 'Stop recording' : 'Voice input'}
              aria-label={isTranscribing ? 'Transcribing' : isRecording ? 'Stop recording' : 'Voice input'}
            >
              {isTranscribing
                ? <Loader2 className="size-4 animate-spin" />
                : isRecording
                ? <MicOff className="size-[17px]" strokeWidth={1.75} />
                : <Mic className="size-[17px]" strokeWidth={1.75} />
              }
            </button>
          </>)}
          hiddenFileInput={(
            /* Visually-hidden (NOT display:none — iOS Safari/PWA is flaky
               clicking display:none inputs); 1px + opacity-0 keeps the gesture
               chain solid and invisible (page.tsx's pattern). */
            <input
              ref={fileInputRef}
              type="file"
              multiple
              aria-hidden="true"
              tabIndex={-1}
              className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
              accept="image/*,audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.pdf,.docx,.xlsx,.txt,.csv,.json,.xml,.md,.markdown,.log,.out,.diff,.patch,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv,text/markdown,application/json,text/xml,application/xml"
              onChange={(e) => {
                const input = e.target;
                const files = input.files?.length ? Array.from(input.files) : [];
                if (!files.length) return;
                // Clear AFTER the bytes are read — clearing input.value mid-read
                // can invalidate File references in Chrome (page.tsx's lesson).
                void attachFiles(files).finally(() => { input.value = ''; });
              }}
            />
          )}
        />
      </div>
      </div>
    </div>
  );
}
