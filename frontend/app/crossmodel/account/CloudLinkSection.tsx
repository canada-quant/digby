'use client';

/**
 * Cloud link — Digby Edge (Phase 3/4) EDGE-side section (Account → Admin).
 * Manages THIS instance's singleton link TO a cloud Digby. Two pairing
 * directions:
 *   1. "Pair to a cloud" (device activation, primary): enter the cloud URL,
 *      mint the code HERE — the cloud admin redeems it under Connected
 *      instances → Pair instance → "Enter the code shown on the edge". The
 *      tunnel client dials the cloud with the code until redeemed or expired.
 *   2. "Have a code from the cloud instead?" (classic): the cloud minted a
 *      code (its "Pair instance" dialog); enter it here.
 * Shows the live tunnel state (connected dot, lastError when state=error),
 * and unlinks (confirm — the cloud is told best-effort, the local row + token
 * die either way). ADMIN-only server-side; the Admin tab only renders for
 * admins.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { cn, copyTextToClipboard } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { instancesApi, type CloudLinkStatus, type PairingCode } from '@/lib/api/instances';
import { usePolling, isAbortError } from '@/lib/use-polling';
import {
  Check, Cloud, CloudOff, Copy, Link2, Loader2, RefreshCw, Unlink,
} from 'lucide-react';

const POLL_MS = 30_000;
/** While a device code waits for the cloud to redeem it, poll tightly. */
const PENDING_POLL_MS = 3_000;

export function CloudLinkSection() {
  const [status, setStatus] = useState<CloudLinkStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [cloudUrl, setCloudUrl] = useState('https://digby.ai');
  const [pairingCode, setPairingCode] = useState('');
  const [pairing, setPairing] = useState(false);
  // Device activation: the code this instance minted, shown ONCE (the server
  // stores only its sha256 — it can never be re-read).
  const [deviceCode, setDeviceCode] = useState<PairingCode | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const load = useCallback(async (silent = false, signal?: AbortSignal) => {
    try {
      setStatus(await instancesApi.getCloudLink({ signal }));
    } catch (err) {
      if (isAbortError(err)) return; // superseded poll tick — never an error
      if (!silent) toast.error('Failed to load cloud link status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // The `connected` flag is live tunnel presence — poll lightly; while a
  // device code is pending (waiting on the cloud admin), poll tightly so the
  // link flips to linked the moment the tunnel lands. usePolling (P5):
  // abortable ticks; the cadence flip re-arms in place (no teardown/refetch
  // churn); immediate:false — the mount load() above owns the first fetch;
  // always-on so the pending→linked flip is caught even in a background tab.
  const pending = status?.state === 'pending';
  usePolling((signal) => load(true, signal), {
    intervalMs: pending || deviceCode ? PENDING_POLL_MS : POLL_MS,
    immediate: false,
    pauseWhenHidden: false,
  });

  // The tunnel landed: the pending row flipped to linked.
  useEffect(() => {
    if (deviceCode && status?.state === 'linked') {
      setDeviceCode(null);
      toast.success(`Linked to ${status.cloudUrl} — the cloud accepted the pairing code`);
    }
  }, [deviceCode, status]);

  // Expiry countdown ticks only while a fresh device code is on screen.
  useEffect(() => {
    if (!deviceCode) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [deviceCode]);

  const generateCode = async () => {
    if (!cloudUrl.trim()) { toast.error('Cloud URL is required'); return; }
    setDeviceBusy(true);
    try {
      const result = await instancesApi.startCloudPairCode({ cloudUrl: cloudUrl.trim() });
      setDeviceCode(result);
      setCopied(false);
      void load(true); // surface the pending row immediately
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to generate a pairing code');
    } finally {
      setDeviceBusy(false);
    }
  };

  const copyCode = async () => {
    if (!deviceCode) return;
    const ok = await copyTextToClipboard(deviceCode.code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Copy failed — select the code and copy it manually');
    }
  };

  const pair = async () => {
    if (!cloudUrl.trim()) { toast.error('Cloud URL is required'); return; }
    if (!pairingCode.trim()) { toast.error('Pairing code is required'); return; }
    setPairing(true);
    try {
      const next = await instancesApi.pairCloud({ cloudUrl: cloudUrl.trim(), pairingCode: pairingCode.trim() });
      setStatus(next);
      setPairingCode('');
      toast.success(`Linked to ${next.cloudUrl}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Pairing failed');
    } finally {
      setPairing(false);
    }
  };

  const unlink = async () => {
    setUnlinking(true);
    try {
      setStatus(await instancesApi.unlinkCloud());
      setDeviceCode(null);
      toast.success('Unlinked from the cloud');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Unlink failed');
    } finally {
      setUnlinking(false);
      setConfirmUnlink(false);
    }
  };

  if (loading) {
    return <div className="flex items-center justify-center py-12"><Loader2 className="size-5 animate-spin text-brand-accent" /></div>;
  }

  const linked = !!status && status.state !== 'unlinked' && status.state !== 'pending';
  const expiresInMs = deviceCode ? new Date(deviceCode.expiresAt).getTime() - now : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Cloud link</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pair this instance to a cloud Digby so its admins can browse and message this instance&apos;s chats from the cloud UI. All data stays here — the cloud proxies through an outbound tunnel.
          </p>
        </div>
        {linked && (
          <Button size="sm" variant="outline" onClick={() => setConfirmUnlink(true)} className="shrink-0">
            <Unlink className="size-3.5 mr-1" /> Unlink
          </Button>
        )}
      </div>

      {linked && status ? (
        <div className="rounded-xl border p-3 space-y-2">
          <div className="flex items-center gap-2">
            {status.connected
              ? <Cloud className="size-4 text-brand-accent shrink-0" />
              : <CloudOff className="size-4 text-muted-foreground shrink-0" />}
            <span className="text-sm font-medium">{status.instanceName || 'This instance'}</span>
            <Badge variant="secondary" className="text-[10px]">{status.state}</Badge>
            <div className="flex-1" />
            <button
              onClick={() => void load()}
              className="text-muted-foreground hover:text-foreground transition-colors"
              title="Refresh status"
            >
              <RefreshCw className="size-3.5" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground font-mono break-all">{status.cloudUrl}</p>
          <p className="flex items-center gap-1.5 text-xs">
            <span className={cn('size-2 rounded-full', status.connected ? 'bg-success-accent' : 'bg-muted-foreground/50')} />
            <span className="text-muted-foreground">
              {status.connected ? 'Tunnel connected' : 'Tunnel disconnected — retrying in the background'}
            </span>
          </p>
          {status.state === 'error' && status.lastError && (
            <p className="text-xs text-destructive break-words">Last error: {status.lastError}</p>
          )}
        </div>
      ) : deviceCode || pending ? (
        <div className="rounded-xl border p-4 space-y-3">
          {deviceCode ? (
            <>
              <div className="flex items-center justify-center gap-3 rounded-xl border bg-muted/40 px-4 py-6">
                <span className="font-mono text-3xl font-bold tracking-[0.2em] select-all">{deviceCode.code}</span>
                <Button variant="ghost" size="icon" onClick={copyCode} title="Copy code" className="flex-shrink-0">
                  {copied ? <Check className="size-4 text-success-accent" /> : <Copy className="size-4" />}
                </Button>
              </div>
              <p className={cn('text-center text-xs', expiresInMs <= 0 ? 'text-destructive' : 'text-muted-foreground')}>
                {expiresInMs <= 0
                  ? 'Expired'
                  : `Expires in ${Math.floor(expiresInMs / 60000)}:${String(Math.floor((expiresInMs % 60000) / 1000)).padStart(2, '0')}`}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              A pairing code is already active (codes are shown once and can&apos;t be recovered). Generate a new code to restart.
            </p>
          )}
          {status?.state === 'error' && status.lastError && (
            <p className="text-xs text-destructive break-words">Last error: {status.lastError}</p>
          )}
          {expiresInMs > 0 && status?.state !== 'error' && (
            <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Waiting for the cloud — enter this code on the cloud under Connected instances → Pair instance → &quot;Enter the code shown on the edge&quot;.
            </p>
          )}
          <div className="flex justify-center">
            <Button
              size="sm"
              variant="outline"
              onClick={generateCode}
              disabled={deviceBusy || !cloudUrl.trim()}
            >
              {deviceBusy ? <Loader2 className="size-3.5 animate-spin mr-1" /> : <Link2 className="size-3.5 mr-1" />}
              Generate a new code
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed p-4 space-y-3">
          {/* Device activation — the primary flow: mint the code HERE. */}
          <div>
            <Label htmlFor="cl-url">Cloud URL</Label>
            <Input
              id="cl-url"
              value={cloudUrl}
              onChange={e => setCloudUrl(e.target.value)}
              placeholder="e.g. digby.ai or https://digby.ai"
            />
          </div>
          <div className="flex justify-end">
            <Button size="sm" onClick={generateCode} disabled={deviceBusy || !cloudUrl.trim()}>
              {deviceBusy ? <Loader2 className="size-3.5 animate-spin mr-1" /> : <Link2 className="size-3.5 mr-1" />}
              Pair to a cloud
            </Button>
          </div>

          {/* Classic direction: the cloud minted the code. */}
          <div className="border-t pt-3 space-y-3">
            <p className="text-xs text-muted-foreground">
              Have a code from the cloud instead? (Its Connected instances → Pair instance dialog.)
            </p>
            <div>
              <Label htmlFor="cl-code">Pairing code</Label>
              <Input
                id="cl-code"
                value={pairingCode}
                onChange={e => setPairingCode(e.target.value)}
                placeholder="Code from the cloud's Pair instance dialog"
                className="font-mono"
              />
            </div>
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={pair} disabled={pairing}>
                {pairing && <Loader2 className="size-3.5 animate-spin mr-1" />}
                Pair with code
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Unlink confirm */}
      <AlertDialog open={confirmUnlink} onOpenChange={setConfirmUnlink}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink from {status?.cloudUrl}?</AlertDialogTitle>
            <AlertDialogDescription>
              The tunnel closes and the stored token is destroyed — the cloud can no longer reach this instance. Nothing on this instance is deleted; re-pair any time with a new code.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={unlink} disabled={unlinking}>
              {unlinking && <Loader2 className="size-3.5 animate-spin mr-1" />}
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
