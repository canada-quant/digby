'use client';

/**
 * ConnectedInstancesSection — Digby Edge (Phase 4) "Connected instances"
 * sidebar section (cloud side). ADMIN-only surfaces mount this (the instances
 * pages gate on role; Account → Admin is admin-only) — the API itself 403s
 * non-admins.
 *
 * One collapsible row per paired edge instance: presence dot (live `online`
 * flag, polled every 60s), name, unlink (confirm). Expanding a row loads the
 * edge's chat list through the tunnel proxy; an offline edge (502) renders a
 * greyed "offline" state instead of a fake empty list. Chat clicks navigate to
 * the instance view (/crossmodel/instances/<id>?chatId=<chatId>).
 *
 * "Pair instance" mints a 10-min single-use code, shown ONCE in a dialog with
 * a copy button + expiry countdown — the code is entered on the edge instance
 * under Account → Admin → Cloud link.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cn, copyTextToClipboard } from '@/lib/utils';
import { usePolling, isAbortError } from '@/lib/use-polling';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  instancesApi, isInstanceOfflineError, instanceErrorMessage,
  type ConnectedInstance, type PairingCode,
} from '@/lib/api/instances';
import { type CrossModelChat } from '@/lib/api/crossmodel';
import { relativeTime } from '@/lib/relative-time';
import {
  Check, ChevronDown, ChevronRight, Copy, Link2, Loader2, MessageSquare,
  Server, Trash2,
} from 'lucide-react';

const POLL_MS = 60_000;
/** While a device-activation redeem is pending, poll for the edge to dial in. */
const REDEEM_POLL_MS = 5_000;

/** Per-instance chat fetch state — 'offline' is the proxied 502, not an error. */
type ChatsState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'offline' }
  | { kind: 'loaded'; chats: CrossModelChat[] };

function PresenceDot({ online, lastSeenAt }: { online: boolean; lastSeenAt: string | null }) {
  return (
    <span
      className={cn('size-1.5 rounded-full flex-shrink-0', online ? 'bg-success-accent' : 'bg-muted-foreground/50')}
      title={online ? 'Online' : `Offline — last seen ${relativeTime(lastSeenAt)}`}
    />
  );
}

export function ConnectedInstancesSection({
  activeInstanceId,
  activeChatId,
}: {
  activeInstanceId?: string;
  activeChatId?: string;
}) {
  const router = useRouter();
  const [instances, setInstances] = useState<ConnectedInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeInstanceId ? [activeInstanceId] : []));
  const [chats, setChats] = useState<Record<string, ChatsState>>({});
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [pairMode, setPairMode] = useState<'generate' | 'redeem'>('generate');
  const [pairingBusy, setPairingBusy] = useState(false);
  // Device activation (cloud side): the code shown on the EDGE, redeemed here.
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemPending, setRedeemPending] = useState<{ expiresAt: string } | null>(null);
  const [redeemBusy, setRedeemBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ConnectedInstance | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [deleteChatTarget, setDeleteChatTarget] = useState<{ instanceId: string; chat: CrossModelChat } | null>(null);
  const [deletingChat, setDeletingChat] = useState(false);
  // Guards against a stale chats fetch overwriting a newer one (rapid expand/
  // collapse or an instance revoked mid-flight).
  const chatsFetchGen = useRef<Record<string, number>>({});
  // Instance ids present when a redeem started — the dial-in is the NEW id.
  const redeemBaseline = useRef<Set<string>>(new Set());

  // The paired Mac's browser / computer-use rows used to render here too
  // (owner 2026-09-21: "seems out of place" — this section is about paired
  // self-hosted INSTANCES). They live in Account → Integrations → Mac agent
  // (account/IMessageCard.tsx) with the rest of the Mac agent's status.
  const load = useCallback(async (silent = false, signal?: AbortSignal) => {
    try {
      const list = await instancesApi.list({ signal });
      setInstances(list);
      setLoadError(false);
    } catch (err) {
      if (isAbortError(err)) return; // superseded poll tick — never an error
      if (!silent) {
        setLoadError(true);
        toast.error('Failed to load connected instances');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Presence poll — silent: a transient failure must not wipe the list.
  // usePolling (P5): abortable ticks so a slow list() can never overwrite a
  // newer one. immediate:false — the mount load() above owns the first fetch;
  // pauseWhenHidden:false preserves the legacy always-on cadence.
  usePolling((signal) => load(true, signal), { intervalMs: POLL_MS, immediate: false, pauseWhenHidden: false });

  // Expiry countdown ticks only while the pair dialog is open.
  useEffect(() => {
    if (!pairOpen) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [pairOpen]);

  const fetchChats = useCallback(async (instanceId: string) => {
    const gen = (chatsFetchGen.current[instanceId] ?? 0) + 1;
    chatsFetchGen.current[instanceId] = gen;
    setChats(prev => ({ ...prev, [instanceId]: { kind: 'loading' } }));
    try {
      const list = await instancesApi.listEdgeChats(instanceId);
      if (chatsFetchGen.current[instanceId] !== gen) return;
      setChats(prev => ({ ...prev, [instanceId]: { kind: 'loaded', chats: list } }));
    } catch (err) {
      if (chatsFetchGen.current[instanceId] !== gen) return;
      setChats(prev => ({
        ...prev,
        [instanceId]: { kind: isInstanceOfflineError(err) ? 'offline' : 'error' },
      }));
    }
  }, []);

  const toggleExpanded = (instance: ConnectedInstance) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(instance.id)) next.delete(instance.id);
      else next.add(instance.id);
      return next;
    });
    if (!expanded.has(instance.id) && !chats[instance.id]) {
      void fetchChats(instance.id);
    }
  };

  const openPairDialog = async () => {
    setPairOpen(true);
    setCopied(false);
    setRedeemCode('');
    setRedeemPending(null);
    if (pairMode === 'redeem') return; // no code to mint in redeem mode
    setPairingBusy(true);
    setPairing(null);
    try {
      setPairing(await instancesApi.startPairing());
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to create a pairing code');
      setPairOpen(false);
    } finally {
      setPairingBusy(false);
    }
  };

  const copyCode = async (code: string) => {
    const ok = await copyTextToClipboard(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Copy failed — select the code and copy it manually');
    }
  };

  /**
   * Device activation (cloud side): redeem the code the EDGE shows. The row
   * materializes only when the edge's pending-pair dial lands on the relay —
   * poll until a NEW instance id appears or the code lapses.
   */
  const redeem = async () => {
    const code = redeemCode.trim();
    if (!code) { toast.error('Enter the code shown on the edge'); return; }
    setRedeemBusy(true);
    try {
      redeemBaseline.current = new Set(instances.map(i => i.id));
      const result = await instancesApi.redeemPairing(code);
      setRedeemPending({ expiresAt: result.expiresAt });
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to redeem the code');
    } finally {
      setRedeemBusy(false);
    }
  };

  // While a redeem is pending, poll fast — the edge dials every ~3s.
  // usePolling (P5): abortable ticks; `enabled` stops the poll the moment the
  // redeem resolves; always-on while pending (the user may be off in the
  // edge's terminal — the dial-in must be caught even in a background tab).
  usePolling(
    async (signal) => {
      if (!redeemPending) return;
      try {
        const list = await instancesApi.list({ signal });
        if (signal.aborted) return;
        setInstances(list);
        const arrived = list.find(i => !redeemBaseline.current.has(i.id));
        if (arrived) {
          setRedeemPending(null);
          setPairOpen(false);
          toast.success(`"${arrived.name}" connected`);
        } else if (Date.now() >= new Date(redeemPending.expiresAt).getTime()) {
          setRedeemPending(null);
          toast.error('The code expired before the edge connected — generate a new one on the edge');
        }
      } catch { /* transient — keep polling */ }
    },
    { intervalMs: REDEEM_POLL_MS, enabled: !!redeemPending, immediate: false, pauseWhenHidden: false },
  );

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await instancesApi.revoke(revokeTarget.id);
      setInstances(prev => prev.filter(i => i.id !== revokeTarget.id));
      toast.success(`Unlinked "${revokeTarget.name}"`);
    } catch {
      toast.error('Failed to unlink instance');
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  };

  /** Delete a chat ON THE EDGE through the tunnel proxy, then drop it locally. */
  const confirmDeleteChat = async () => {
    if (!deleteChatTarget) return;
    const { instanceId, chat } = deleteChatTarget;
    setDeletingChat(true);
    try {
      await instancesApi.deleteEdgeChat(instanceId, chat.id);
      setChats(prev => {
        const s = prev[instanceId];
        return s?.kind === 'loaded'
          ? { ...prev, [instanceId]: { kind: 'loaded', chats: s.chats.filter(c => c.id !== chat.id) } }
          : prev;
      });
      // The deleted chat was open in the view — leave it.
      if (activeInstanceId === instanceId && activeChatId === chat.id) {
        router.push(`/instances/${instanceId}`);
      }
      toast.success(`Deleted "${chat.title || 'Untitled chat'}" on the edge`);
    } catch (err) {
      toast.error(isInstanceOfflineError(err)
        ? 'Instance is offline — the chat was NOT deleted. Try again when it reconnects.'
        : instanceErrorMessage(err, 'Failed to delete the chat'));
    } finally {
      setDeletingChat(false);
      setDeleteChatTarget(null);
    }
  };

  const expiresInMs = pairing ? new Date(pairing.expiresAt).getTime() - now : 0;
  const expiryLabel = pairing
    ? expiresInMs <= 0
      ? 'Expired'
      : `Expires in ${Math.floor(expiresInMs / 60000)}:${String(Math.floor((expiresInMs % 60000) / 1000)).padStart(2, '0')}`
    : '';

  return (
    <div>
      {/* Header row — mirrors the sidebar's section labels (Digby Frontier:
          sentence-case 12px ink-3, no uppercase tracking). */}
      <div className="flex items-center justify-between gap-1 px-2.5 pt-4 pb-1.5">
        <button
          onClick={() => setCollapsed(c => !c)}
          className="flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink-2 transition-colors"
        >
          {collapsed ? <ChevronRight className="size-3 opacity-70" /> : <ChevronDown className="size-3 opacity-70" />}
          Connected instances
        </button>
        <button
          onClick={openPairDialog}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          title="Pair a self-hosted instance"
        >
          <Link2 className="size-3" />
          Pair instance
        </button>
      </div>

      {!collapsed && (
        <div className="space-y-0.5">
          {loading && (
            <div className="flex justify-center py-3"><Loader2 className="size-3.5 animate-spin text-muted-foreground" /></div>
          )}
          {!loading && loadError && (
            <button
              onClick={() => { setLoading(true); void load(); }}
              className="w-full rounded-md border border-dashed px-2 py-2 text-center text-[11px] text-destructive hover:bg-muted/50 transition-colors"
            >
              Couldn&apos;t load instances — retry
            </button>
          )}
          {!loading && !loadError && instances.length === 0 && (
            <p className="px-1 py-1.5 text-[11px] text-muted-foreground">
              No paired instances — pair a self-hosted Digby to browse it here.
            </p>
          )}

          {instances.map(instance => {
            const isExpanded = expanded.has(instance.id);
            const state = chats[instance.id];
            return (
              <div key={instance.id}>
                <div
                  className={cn(
                    'group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs cursor-pointer hover:bg-muted/50 transition-colors',
                    activeInstanceId === instance.id && 'bg-muted/70',
                  )}
                  onClick={() => toggleExpanded(instance)}
                >
                  {isExpanded
                    ? <ChevronDown className="size-3 text-muted-foreground flex-shrink-0" />
                    : <ChevronRight className="size-3 text-muted-foreground flex-shrink-0" />}
                  <PresenceDot online={instance.online} lastSeenAt={instance.lastSeenAt} />
                  <Server className="size-3.5 text-ink-3 flex-shrink-0" />
                  <span className="flex-1 truncate font-medium">{instance.name}</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); setRevokeTarget(instance); }}
                    className="opacity-60 md:opacity-0 md:group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                    title="Unlink instance"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>

                {isExpanded && (
                  <div className="ml-5 border-l pl-1.5 space-y-0.5 py-0.5">
                    {!state || state.kind === 'loading' ? (
                      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" /> Loading chats…
                      </div>
                    ) : state.kind === 'offline' ? (
                      <p className="px-2 py-1 text-[11px] text-muted-foreground italic">
                        Offline — chats unavailable until the instance reconnects.
                      </p>
                    ) : state.kind === 'error' ? (
                      <button
                        onClick={() => void fetchChats(instance.id)}
                        className="px-2 py-1 text-[11px] text-destructive hover:underline"
                      >
                        Couldn&apos;t load chats — retry
                      </button>
                    ) : state.chats.length === 0 ? (
                      <p className="px-2 py-1 text-[11px] text-muted-foreground">No chats on this instance.</p>
                    ) : (
                      state.chats.map(chat => (
                        <div key={chat.id} className="group flex items-center">
                          <button
                            onClick={() => router.push(`/instances/${instance.id}?chatId=${chat.id}`)}
                            className={cn(
                              'flex flex-1 min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50 transition-colors',
                              activeChatId === chat.id && 'bg-muted/70 font-medium',
                            )}
                          >
                            <MessageSquare className="size-3 text-muted-foreground flex-shrink-0" />
                            <span className="flex-1 truncate">{chat.title || 'Untitled chat'}</span>
                            {chat.running && <span className="size-1.5 rounded-full bg-ok animate-pulse flex-shrink-0" title="A run is active" />}
                          </button>
                          <button
                            onClick={() => setDeleteChatTarget({ instanceId: instance.id, chat })}
                            className="opacity-60 md:opacity-0 md:group-hover:opacity-100 px-1 text-muted-foreground hover:text-destructive transition-all flex-shrink-0"
                            title="Delete this chat on the instance"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pair dialog — two directions: mint a code here (edge redeems it), or
          enter the code the edge minted (device activation). Codes are shown
          ONCE (never re-readable server-side). */}
      <Dialog open={pairOpen} onOpenChange={setPairOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pair an instance</DialogTitle>
            <DialogDescription>
              {pairMode === 'generate'
                ? 'Enter this code on the edge instance under Settings → Cloud link (Account → Admin). It is single-use and valid for 10 minutes.'
                : 'On your self-hosted instance: Account → Admin → Cloud link → Pair to a cloud, then enter the code it shows here.'}
            </DialogDescription>
          </DialogHeader>

          {/* Direction toggle */}
          <div className="flex rounded-lg border p-0.5 text-xs">
            {(['generate', 'redeem'] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setPairMode(mode)}
                className={cn(
                  'flex-1 rounded-md px-2 py-1.5 transition-colors',
                  pairMode === mode ? 'bg-send text-send-ink' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {mode === 'generate' ? 'Generate a code for the edge' : 'Enter the code shown on the edge'}
              </button>
            ))}
          </div>

          {pairMode === 'generate' ? (
            pairingBusy ? (
              <div className="flex justify-center py-8"><Loader2 className="size-5 animate-spin text-ink-3" /></div>
            ) : pairing ? (
              <div className="space-y-4">
                <div className="flex items-center justify-center gap-3 rounded-xl border bg-muted/40 px-4 py-6">
                  <span className="font-mono text-3xl font-bold tracking-[0.2em] select-all">{pairing.code}</span>
                  <Button variant="ghost" size="icon" onClick={() => void copyCode(pairing.code)} title="Copy code" className="flex-shrink-0">
                    {copied ? <Check className="size-4 text-success-accent" /> : <Copy className="size-4" />}
                  </Button>
                </div>
                <p className={cn('text-center text-xs', expiresInMs <= 0 ? 'text-destructive' : 'text-muted-foreground')}>
                  {expiryLabel}
                </p>
                {expiresInMs <= 0 && (
                  <div className="flex justify-center">
                    <Button size="sm" variant="outline" onClick={openPairDialog}>Generate a new code</Button>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  On the edge instance: Account → Admin → Cloud link → paste this code and the URL of this instance, then Pair.
                </p>
              </div>
            ) : null
          ) : (
            <div className="space-y-4">
              {redeemPending ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border bg-muted/40 px-4 py-6">
                  <Loader2 className="size-5 animate-spin text-ink-3" />
                  <p className="text-sm font-medium">Waiting for the edge to connect…</p>
                  <p className="text-[11px] text-muted-foreground text-center">
                    The edge dials in every few seconds — the new instance appears here automatically.
                  </p>
                </div>
              ) : (
                <>
                  <Input
                    value={redeemCode}
                    onChange={e => setRedeemCode(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') void redeem(); }}
                    placeholder="XXXX-XXXX"
                    className="font-mono text-center text-lg tracking-[0.2em]"
                    maxLength={16}
                    autoFocus
                  />
                  <div className="flex justify-end">
                    <Button size="sm" onClick={() => void redeem()} disabled={redeemBusy || !redeemCode.trim()}>
                      {redeemBusy && <Loader2 className="size-3.5 animate-spin mr-1" />}
                      Add instance
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink &quot;{revokeTarget?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              The pairing is revoked on this instance — the edge&apos;s tunnel token stops working immediately. The edge keeps its own data; re-pair any time with a new code.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRevoke} disabled={revoking}>
              {revoking && <Loader2 className="size-3.5 animate-spin mr-1" />}
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete edge chat confirm — the delete happens ON THE EDGE via the tunnel. */}
      <AlertDialog open={!!deleteChatTarget} onOpenChange={(open) => !open && setDeleteChatTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &quot;{deleteChatTarget?.chat.title || 'Untitled chat'}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the chat on instance &quot;{
                instances.find(i => i.id === deleteChatTarget?.instanceId)?.name ?? 'this instance'
              }&quot;. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteChat} disabled={deletingChat}>
              {deletingChat && <Loader2 className="size-3.5 animate-spin mr-1" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
