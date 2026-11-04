'use client';

/**
 * Platform unification (P3) — "Agent tokens" card for Account settings.
 *
 * Mint/list/revoke scoped API tokens (dgt_…) for external agents and scripts
 * calling the platform REST API (/api/crossmodel/platform). The raw token is
 * shown exactly once at mint — only its sha256 hash is stored server-side.
 * Hidden for child accounts (the account page bounces kids anyway; the tab is
 * also filtered out in page.tsx, matching models/integrations).
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { agentTokensApi, AgentTokenScope, AgentTokenSummary, MintedAgentToken } from '@/lib/api/platform';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { relativeTime, absoluteDate } from '@/lib/relative-time';
import { KeyRound, Loader2, Plus, Trash2, Copy, Check, AlertTriangle } from 'lucide-react';

const SCOPES: { id: AgentTokenScope; blurb: string }[] = [
  { id: 'chats:read',      blurb: 'List chats and read live chat status.' },
  { id: 'chats:write',     blurb: 'Create, rename, move, archive, and delete chats; send messages.' },
  { id: 'folders:read',    blurb: 'Read the folder tree (owned + shared folders).' },
  { id: 'folders:write',   blurb: 'Create, edit, move, and delete folders.' },
  { id: 'schedules:write', blurb: 'Create, list, and cancel scheduled chat runs.' },
  { id: 'code:run',        blurb: 'Start coding sessions in workspace folders. Powerful — grant sparingly.' },
];

export function AgentTokensTab() {
  const [tokens, setTokens] = useState<AgentTokenSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<AgentTokenScope>>(new Set(['chats:read']));
  const [expiry, setExpiry] = useState(''); // yyyy-mm-dd
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<MintedAgentToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AgentTokenSummary | null>(null);
  const [revoking, setRevoking] = useState(false);

  const loadTokens = () => {
    setLoading(true);
    agentTokensApi.list()
      .then((t) => { setTokens(t); setLoadError(false); })
      // Honest failure — never render "No tokens yet" over an errored fetch.
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  };
  useEffect(() => { loadTokens(); }, []);

  const toggleScope = (s: AgentTokenScope) => {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  };

  const mint = async () => {
    if (!name.trim()) { toast.error('Give the token a name'); return; }
    if (!scopes.size) { toast.error('Pick at least one scope'); return; }
    setMinting(true);
    try {
      const t = await agentTokensApi.mint({
        name: name.trim(),
        scopes: [...scopes],
        ...(expiry ? { expiresAt: new Date(`${expiry}T23:59:59Z`).toISOString() } : {}),
      });
      setMinted(t);
      setCopied(false);
      setName(''); setScopes(new Set(['chats:read'])); setExpiry('');
      const list = await agentTokensApi.list().catch(() => null);
      if (list) setTokens(list);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not create token');
    } finally {
      setMinting(false);
    }
  };

  const copyMinted = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
      toast.success('Token copied');
    } catch {
      toast.error('Copy failed — select the token text manually');
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await agentTokensApi.revoke(revokeTarget.id);
      setTokens((prev) => prev.map((t) => t.id === revokeTarget.id ? { ...t, revokedAt: new Date().toISOString() } : t));
      if (minted?.id === revokeTarget.id) setMinted(null);
      toast.message(`"${revokeTarget.name}" revoked`);
    } catch {
      toast.error('Could not revoke token');
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  };

  const active = tokens.filter((t) => !t.revokedAt);
  const revoked = tokens.filter((t) => t.revokedAt);

  if (loading) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  }

  return (
    <div className="space-y-8 max-w-2xl">
      {/* ── Mint form ── */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <KeyRound className="size-4 text-brand-accent" />
          <h3 className="text-sm font-semibold">Agent tokens</h3>
          {minting && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Scoped API tokens let external agents and scripts use Digby as you — create chats, send messages,
          start coding sessions, manage schedules — via the platform API (<code className="font-mono">/api/crossmodel/platform</code>).
          A token can only do what its scopes allow, and never more than you can.
        </p>

        {/* Newly minted token — shown ONCE */}
        {minted && (
          <div className="mb-4 rounded-xl border border-warn/50 bg-warn/10 p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-warn-ink mb-1.5">
              <AlertTriangle className="size-3.5" /> Shown once — copy now. It can&apos;t be retrieved again.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border border-warn/40 bg-background px-2.5 py-1.5 text-xs font-mono break-all select-all">
                {minted.token}
              </code>
              <button
                onClick={copyMinted}
                className="shrink-0 flex items-center gap-1 text-xs bg-brand text-brand-foreground rounded-md px-2.5 py-1.5"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-border p-3 space-y-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Token name (e.g. CI bot, Claude on my laptop)"
            maxLength={100}
            className="w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-xs outline-none focus:border-brand-ring"
          />
          <div className="space-y-1.5">
            {SCOPES.map((s) => (
              <label key={s.id} className="flex items-start gap-2.5 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={scopes.has(s.id)}
                  onChange={() => toggleScope(s.id)}
                  className="mt-0.5 accent-brand-accent"
                />
                <span className="flex-1">
                  <span className={cn('text-xs font-mono font-medium', s.id === 'code:run' && 'text-warn-ink')}>{s.id}</span>
                  <span className="block text-[11px] text-muted-foreground">{s.blurb}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-[11px] text-muted-foreground">
              Expires (optional):{' '}
              <input
                type="date"
                value={expiry}
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                onChange={(e) => setExpiry(e.target.value)}
                className="rounded-md border border-border bg-transparent px-1.5 py-1 text-xs outline-none focus:border-brand-ring"
              />
            </label>
            <button
              onClick={mint}
              disabled={minting}
              className="flex items-center gap-1.5 text-xs bg-brand text-brand-foreground rounded-md px-3 py-1.5 disabled:opacity-40"
            >
              <Plus className="size-3.5" /> Create token
            </button>
          </div>
        </div>
      </div>

      {/* ── Token list ── */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Your tokens {active.length > 0 && <span className="text-muted-foreground font-normal">({active.length})</span>}</h3>
        {tokens.length === 0 && loadError ? (
          <LoadErrorState message="Couldn't load your agent tokens." onRetry={loadTokens} className="py-6" />
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">No tokens yet. Create one above to let an external agent use Digby as you.</p>
        ) : (
          <div className="space-y-1.5">
            {tokens.map((t) => {
              const expired = t.expiresAt && new Date(t.expiresAt).getTime() <= Date.now();
              const dead = !!t.revokedAt || expired;
              return (
                <div key={t.id} className={cn('rounded-lg border border-border px-3 py-2.5', dead && 'opacity-55')}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium truncate">{t.name}</span>
                    <code className="text-[11px] font-mono text-muted-foreground shrink-0">{t.tokenPrefix}…</code>
                    <span className="flex-1" />
                    {t.revokedAt ? (
                      <Badge variant="secondary" className="text-[12px]">revoked</Badge>
                    ) : expired ? (
                      <Badge variant="warning" className="text-[12px]">expired</Badge>
                    ) : (
                      <button
                        onClick={() => setRevokeTarget(t)}
                        title="Revoke"
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive shrink-0"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {t.scopes.map((s) => (
                      <Badge key={s} variant="outline" className="rounded-full px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">{s}</Badge>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    {t.lastUsedAt ? `last used ${relativeTime(t.lastUsedAt)}` : 'never used'}
                    {' · '}
                    {t.expiresAt ? `expires ${absoluteDate(t.expiresAt)}` : 'no expiry'}
                  </p>
                </div>
              );
            })}
          </div>
        )}
        {revoked.length > 0 && (
          <p className="text-[11px] text-muted-foreground mt-2">Revoked tokens stay listed for audit but no longer work.</p>
        )}
      </div>

      {/* ── Revoke confirm ── */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke &quot;{revokeTarget?.name}&quot;?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything using this token ({revokeTarget?.tokenPrefix}…) stops working immediately. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={revoke} disabled={revoking} className="bg-destructive hover:bg-destructive/90">
              {revoking && <Loader2 className="size-3.5 animate-spin mr-1.5" />}
              Revoke token
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
