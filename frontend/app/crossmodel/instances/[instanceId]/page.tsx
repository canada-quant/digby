'use client';

/**
 * Instance chat view — Digby Edge (Phase 4). Browse + interact with one paired
 * edge instance's chats through the tunnel proxy. Deep link:
 *   /crossmodel/instances/<instanceId>?chatId=<chatId>
 * (sidebar chat clicks navigate here; ?chatId is reactive — picking another
 * chat in the rail swaps the thread without a remount).
 *
 * Read path: GET proxy /crossmodel/chats/:id (full transcript — the paged
 * hasMoreMessages envelope is not used here yet). Send path: POST the edge's
 * platform messages endpoint (202 detached turn — idle starts, busy queues),
 * then attach to the edge's unified run stream via EventSource on the proxied
 * /crossmodel/chats/:id/stream (cookie auth — no token query param, same as
 * the main chat surface).
 *
 * Honest states: an offline instance (presence flag or a proxied 502) greys
 * the thread + disables the composer; a failed load renders the shared
 * LoadErrorState with Retry.
 */

import { Suspense, use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { MarkdownContent } from '@/components/ui/custom/prompt/markdown-content';
import { authApi } from '@/lib/auth';
import { isDefinitiveAuthFailure } from '@/lib/api-client';
import {
  instancesApi, isInstanceOfflineError, instanceErrorMessage,
  type ConnectedInstance,
} from '@/lib/api/instances';
import { usePolling } from '@/lib/use-polling';
import type { CrossModelChatDetail, Message } from '@/lib/api/crossmodel';
import AppRail, { useRailOpen } from '@/components/ui/custom/app-rail';
import { ConnectedInstancesSection } from '../../components/ConnectedInstancesSection';
import { relativeTime } from '@/lib/relative-time';
import { enterKeySubmits, isTouchPrimary } from '@/lib/composer-enter';
import { ArrowLeft, Loader2, MessageSquare, PanelLeftOpen, SendHorizonal, WifiOff } from 'lucide-react';

type ChatState =
  | { kind: 'idle' }                 // no ?chatId — pick one
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'offline' }              // proxied 502 — the edge is down
  | { kind: 'loaded'; chat: CrossModelChatDetail };

const PRESENCE_POLL_MS = 60_000;

function InstanceChatView({ instanceId }: { instanceId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const chatId = searchParams.get('chatId') || '';

  const [instance, setInstance] = useState<ConnectedInstance | null>(null);
  // Instance-list rail: open on desktop (static column), closed on phones
  // until the header button opens the drawer (shared SSR-safe default).
  const [railOpen, setRailOpen] = useRailOpen();
  const [chatState, setChatState] = useState<ChatState>({ kind: 'idle' });
  const [composer, setComposer] = useState('');
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [streamStatus, setStreamStatus] = useState('');
  const [queuedNote, setQueuedNote] = useState('');

  const eventSourceRef = useRef<EventSource | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  // A stale stream (previous chat / superseded send) must never write state.
  const streamGenRef = useRef(0);

  // ── Instance presence (header dot) — silent 60s poll ─────────────────────
  // usePolling (P5): abortable ticks (failures/aborts are silent — presence is
  // best-effort); `key` restarts the poll when the route's instance changes.
  usePolling(
    (signal) => instancesApi.list({ signal }),
    {
      intervalMs: PRESENCE_POLL_MS,
      key: instanceId,
      pauseWhenHidden: false, // legacy behavior: the light presence cadence keeps running hidden
      onData: (list) => setInstance(list.find(i => i.id === instanceId) ?? null),
    },
  );

  const closeStream = useCallback(() => {
    streamGenRef.current += 1;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setStreaming(false);
    setStreamedText('');
    setStreamStatus('');
  }, []);

  const loadChat = useCallback(async (id: string) => {
    setChatState({ kind: 'loading' });
    try {
      const chat = await instancesApi.getEdgeChat(instanceId, id);
      setChatState({ kind: 'loaded', chat });
      return chat;
    } catch (err) {
      if (isInstanceOfflineError(err)) setChatState({ kind: 'offline' });
      else setChatState({ kind: 'error', message: instanceErrorMessage(err, "Couldn't load this chat") });
      return null;
    }
  }, [instanceId]);

  /**
   * Attach to the chat's active run (replay + live tail). Chunks accumulate
   * into streamedText; 'complete' finalizes and refetches the transcript from
   * the edge so the stored row (title, metadata) replaces the local stream.
   */
  const attachStream = useCallback((id: string) => {
    closeStream();
    const gen = streamGenRef.current;
    const es = new EventSource(instancesApi.edgeChatStreamUrl(instanceId, id));
    eventSourceRef.current = es;
    setStreaming(true);
    let text = '';

    es.onmessage = (event) => {
      if (streamGenRef.current !== gen) return;
      let data: any;
      try { data = JSON.parse(event.data); } catch { return; }

      if (data.type === 'chunk') {
        text += data.data?.content ?? '';
        setStreamedText(text);
      } else if (data.type === 'progress') {
        const msg = data.data?.message;
        if (typeof msg === 'string') setStreamStatus(msg);
      } else if (data.type === 'queued') {
        // The edge was busy — the message runs when the current turn finishes.
        const pos = typeof data.data?.position === 'number' ? data.data.position : null;
        setQueuedNote(pos ? `Queued — runs when the current turn finishes (position ${pos}).` : 'Queued — runs when the current turn finishes.');
        closeStream();
        void loadChat(id);
      } else if (data.type === 'complete') {
        const interrupted = data.data?.interrupted === true;
        closeStream();
        // Interrupted on attach = no live run (idle chat) — nothing to do.
        if (!interrupted) void loadChat(id);
      } else if (data.type === 'error') {
        closeStream();
        toast.error(typeof data.data?.error === 'string' ? data.data.error : 'The run failed on the edge instance');
        void loadChat(id);
      }
    };

    es.onerror = () => {
      if (streamGenRef.current !== gen) return;
      // Runs are detached — the turn survives a dropped socket. Close (the
      // default retry would replay buffered chunks and duplicate the local
      // accumulation) and resync the transcript from the edge.
      closeStream();
      toast.error('Lost the stream connection — resynced the chat from the instance.');
      setTimeout(() => void loadChat(id), 1500);
    };
  }, [instanceId, closeStream, loadChat]);

  // ── Deep link: react to ?chatId changes (rail clicks don't remount) ──────
  useEffect(() => {
    setQueuedNote('');
    if (!chatId) {
      closeStream();
      setChatState({ kind: 'idle' });
      return;
    }
    closeStream();
    void loadChat(chatId).then(chat => {
      // A chat reported as running gets a live attach immediately.
      if (chat?.running) attachStream(chat.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, instanceId]);

  // Unmount cleanup.
  useEffect(() => () => { streamGenRef.current += 1; eventSourceRef.current?.close(); }, []);

  // Keep the thread pinned to the bottom as content streams in.
  const messages: Message[] = chatState.kind === 'loaded' ? chatState.chat.messages : [];
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, streamedText, streamStatus]);

  const offline = instance?.online === false || chatState.kind === 'offline';

  const send = async () => {
    const content = composer.trim();
    if (!content || !chatId || sending || streaming || offline) return;
    setSending(true);
    setQueuedNote('');
    try {
      const result = await instancesApi.sendEdgeMessage(instanceId, chatId, content);
      setComposer('');
      // Optimistic user echo — the post-complete refetch replaces it with the
      // stored row.
      setChatState(prev => prev.kind === 'loaded'
        ? { kind: 'loaded', chat: { ...prev.chat, messages: [...prev.chat.messages, { role: 'user', content, timestamp: new Date().toISOString() }] } }
        : prev);
      if (result.queued) {
        setQueuedNote(result.note || (result.position
          ? `Queued — runs when the current turn finishes (position ${result.position}).`
          : 'Queued — runs when the current turn finishes.'));
        void loadChat(chatId);
      } else {
        attachStream(chatId);
      }
    } catch (err) {
      if (isInstanceOfflineError(err)) setChatState({ kind: 'offline' });
      toast.error(instanceErrorMessage(err, 'Failed to send the message'));
    } finally {
      setSending(false);
    }
  };

  const chat = chatState.kind === 'loaded' ? chatState.chat : null;

  return (
    <div className="fixed inset-0 flex bg-background overflow-hidden" style={{ height: 'var(--app-height, 100dvh)', top: 'var(--app-top, 0px)' }}>
      {/* Left rail — the shared Connected instances browser on the shared
          AppRail shell (Phase 1). Before this pass the rail was `hidden
          md:flex` — UNREACHABLE ON PHONES; it is now a real drawer opened by
          the header's list button. */}
      <AppRail open={railOpen} onClose={() => setRailOpen(false)} label="Connected instances list">
        <div className="p-2 border-b flex items-center gap-1">
          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <ArrowLeft className="size-3.5" />
            Back to chats
          </button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          <ConnectedInstancesSection activeInstanceId={instanceId} activeChatId={chatId || undefined} />
        </div>
      </AppRail>

      <main className="flex-1 flex flex-col min-w-0">
        {/* Header: instance name + presence + active chat title */}
        <header className="flex items-center gap-2 border-b px-4 py-2.5">
          <button
            onClick={() => router.push('/instances')}
            className="md:hidden text-muted-foreground hover:text-foreground"
            title="All instances"
          >
            <ArrowLeft className="size-4" />
          </button>
          {/* Mobile: open the instance-list drawer (Phase 1 — the rail used to
              be simply hidden below md). */}
          <button
            onClick={() => setRailOpen(true)}
            className="md:hidden text-muted-foreground hover:text-foreground"
            title="Open instances list"
            aria-label="Open instances list"
          >
            <PanelLeftOpen className="size-4" />
          </button>
          <span
            className={cn('size-2 rounded-full flex-shrink-0', instance?.online ? 'bg-success-accent' : 'bg-muted-foreground/50')}
            title={instance?.online ? 'Online' : `Offline — last seen ${relativeTime(instance?.lastSeenAt)}`}
          />
          <span className="text-sm font-semibold truncate">{instance?.name ?? 'Instance'}</span>
          {chat && (
            <>
              <span className="text-muted-foreground">/</span>
              <span className="text-sm text-muted-foreground truncate">{chat.title || 'Untitled chat'}</span>
            </>
          )}
        </header>

        {/* Thread */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {chatState.kind === 'idle' && (
            <div className="h-full flex items-center justify-center">
              <div className="text-center space-y-2 px-6">
                <MessageSquare className="size-8 text-muted-foreground/40 mx-auto" />
                <p className="text-xs text-muted-foreground">Pick a chat from the instance&apos;s list to open its transcript.</p>
              </div>
            </div>
          )}

          {chatState.kind === 'loading' && (
            <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-brand-accent" /></div>
          )}

          {chatState.kind === 'error' && (
            <LoadErrorState message={chatState.message} onRetry={() => void loadChat(chatId)} />
          )}

          {chatState.kind === 'offline' && (
            <div className="py-16 text-center space-y-2">
              <WifiOff className="size-6 text-muted-foreground/50 mx-auto" />
              <p className="text-xs text-muted-foreground">
                This instance is offline — its chats are unavailable until it reconnects.
              </p>
              <Button size="sm" variant="outline" onClick={() => void loadChat(chatId)}>Retry</Button>
            </div>
          )}

          {chat && (
            <div className={cn('max-w-3xl mx-auto px-4 py-4 space-y-4', offline && 'opacity-60')}>
              {messages.length === 0 && !streaming && (
                <p className="text-center text-xs text-muted-foreground py-8">No messages yet — send the first one below.</p>
              )}
              {messages.map((m, i) => (
                <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  {m.role === 'user' ? (
                    <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-bubble text-ink px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
                      {m.content}
                    </div>
                  ) : (
                    <div className="max-w-[85%] min-w-0 text-sm">
                      <MarkdownContent>{m.content}</MarkdownContent>
                    </div>
                  )}
                </div>
              ))}

              {/* Live stream bubble */}
              {streaming && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] min-w-0 text-sm">
                    {streamedText
                      ? <MarkdownContent>{streamedText}</MarkdownContent>
                      : (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" />
                          {streamStatus || 'Working…'}
                        </div>
                      )}
                  </div>
                </div>
              )}

              {queuedNote && (
                <p className="text-center text-[11px] text-warn-ink">{queuedNote}</p>
              )}
              <div ref={threadEndRef} />
            </div>
          )}
        </div>

        {/* Composer */}
        {chat && (
          <div className="border-t px-4 py-3">
            {offline && (
              <p className="max-w-3xl mx-auto mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <WifiOff className="size-3" /> Instance offline — sending is disabled until it reconnects.
              </p>
            )}
            <div className="max-w-3xl mx-auto flex items-end gap-2">
              <textarea
                value={composer}
                onChange={e => setComposer(e.target.value)}
                onKeyDown={e => {
                  // Device-aware Enter (ticket 67fc53a7): desktop sends on
                  // plain Enter (Shift+Enter newline); touch-primary gets the
                  // iMessage behavior (Enter = newline, Send button sends).
                  if (enterKeySubmits(e, undefined, isTouchPrimary())) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={2}
                disabled={offline || sending || streaming}
                placeholder={offline ? 'Instance offline' : `Message ${instance?.name ?? 'instance'}…`}
                className="flex-1 resize-none rounded-xl border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-accent disabled:opacity-60"
              />
              <Button
                size="icon"
                onClick={() => void send()}
                disabled={!composer.trim() || offline || sending || streaming}
                title="Send"
                className="rounded-xl"
              >
                {sending ? <Loader2 className="size-4 animate-spin" /> : <SendHorizonal className="size-4" />}
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function InstancePage({ params }: { params: Promise<{ instanceId: string }> }) {
  const { instanceId } = use(params);
  const router = useRouter();
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    authApi.getCurrentUser()
      .then(u => {
        if (u.role !== 'ADMIN') router.replace('/');
        else setAllowed(true);
      })
      .catch((err) => {
        // 05303f58: bounce only on a definitive 401 (refresh already failed) —
        // a network blip/5xx keeps the token and the spinner stays.
        if (isDefinitiveAuthFailure(err)) router.push('/login');
        else console.warn('getCurrentUser failed (non-auth) — staying put', err);
      });
  }, [router]);

  if (!allowed) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-brand-accent" />
      </div>
    );
  }

  // Suspense: useSearchParams inside the view requires a boundary (Next 16).
  return (
    <Suspense fallback={
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <Loader2 className="size-5 animate-spin text-brand-accent" />
      </div>
    }>
      <InstanceChatView instanceId={instanceId} />
    </Suspense>
  );
}
