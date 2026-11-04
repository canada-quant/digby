'use client';

/**
 * Mac agent card (Account → Integrations).
 *
 * ONE paired Mac runs the downloadable Digby agent, and three capabilities ride
 * that single pairing: iMessage (read recent conversations, send), the local
 * BROWSER driver (Digby's own Playwright profile on the Mac — the browser
 * router's local gate) and COMPUTER USE (Digby sees and drives the user's real
 * screen). The backend relays each action to the paired Mac over an HTTP
 * long-poll link; `imessageApi.getStatus` carries all three availability gates.
 *
 * Owner 2026-09-21: the Browser / Computer-use status rows used to sit in the
 * chat sidebar's "Connected instances" section (an admin-only list of paired
 * self-hosted INSTANCES) — "seems out of place… shouldn't that go in the
 * integrations section of settings?". They render here now, under the Mac they
 * belong to, for every signed-in user.
 */

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  MessageCircle,
  Loader2,
  Plus,
  Unlink,
  Send,
  Copy,
  RefreshCw,
  Download,
  Laptop,
  Globe,
  Monitor,
} from 'lucide-react';
import {
  imessageApi,
  type IMessageStatus,
  type IMessageChat,
  type IMessageMessage,
  type IMessageAgentInfo,
} from '@/lib/api/crossmodel';
import { usePolling } from '@/lib/use-polling';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { macAgentInstallCommand, macAgentUpdateCommand } from '@/lib/instance-setup';
import { detectPlatform } from '@/app/(site)/_components/PlatformCta';

// Served directly from digby.example.com (frontend public/). The one-line installer pulls
// the agent tarball, builds, pairs, and sets up the background service.
const INSTALL_HOST = process.env.NEXT_PUBLIC_IMESSAGE_INSTALL_HOST || 'https://digby.example.com';
const AGENT_DOWNLOAD_URL = '/digby-imessage-agent.tar.gz';
// The signed/notarized installer is published at /DigbyAgent.pkg (frontend/public/).
// This drives the zero-Terminal download flow; override via env if hosted elsewhere.
const PKG_URL = process.env.NEXT_PUBLIC_IMESSAGE_PKG_URL || '/DigbyAgent.pkg';

function fmtTime(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Dotted-numeric compare: is `candidate` strictly OLDER than `latest`?
 * Non-parseable / missing candidate → false (we never claim "outdated" about a
 * version we cannot read — ticket 31fd8440: an unreadable version must render
 * the plain "agent v?" line, not a stale badge).
 */
export function agentVersionOlder(candidate?: string | null, latest?: string | null): boolean {
  if (!candidate || !latest) return false;
  const a = candidate.split('.').map((n) => parseInt(n, 10));
  const b = latest.split('.').map((n) => parseInt(n, 10));
  if (a.some(isNaN) || b.some(isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * 405927c9 interim (Fleet directive 2026-10-25, "make it professional"): is the
 * served .pkg FRESH enough to feature as the primary install path?
 * build-pkg.sh writes /DigbyAgent.pkg.json next to the pkg at publish time; the
 * pkg served before that (the June 2026 nameless-window build the owner hit)
 * has NO stamp, so a missing stamp means "unknown/older build" → false: the
 * one-line installer (which always pulls the CURRENT release) takes over as the
 * primary path and the pkg download is not offered. A stamp whose agentVersion
 * is older than the release manifest (latestAgentVersion) is likewise stale.
 * FAIL CLOSED throughout: a latest version that hasn't loaded or is unreadable,
 * and any non-string value parsed from a hand-edited stamp, all count as NOT
 * fresh — featuring a download is not badging the user's own device.
 */
export function pkgStampIsFresh(
  stamp: { agentVersion?: string | null } | null | undefined,
  latest?: string | null,
): boolean {
  // FAIL CLOSED (reviewer MAJOR 2/MINOR 5, 2026-10-25): featuring a download is
  // not badging the user's own device — the 31fd8440 "unreadable version →
  // never outdated" rule does not transfer here. A missing stamp, a non-object
  // stamp, a missing/malformed stamp agentVersion, or a latest release version
  // that hasn't loaded (or is unreadable) all mean "don't feature the pkg".
  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) return false;
  const v = stamp.agentVersion;
  // typeof guards (reviewer MINOR 2, 2026-10-25): JSON.parse yields live
  // values, so a hand-edited stamp with an UNQUOTED version arrives as a
  // number — agentVersionOlder would throw a TypeError in the render body and
  // unmount the whole card to the app error boundary.
  if (typeof v !== 'string' || !/^\d+(\.\d+)*$/.test(v)) return false;
  if (typeof latest !== 'string' || !/^\d+(\.\d+)*$/.test(latest)) return false;
  return !agentVersionOlder(v, latest);
}

export default function IMessageCard() {
  const [status, setStatus] = useState<IMessageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [pairOpen, setPairOpen] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  // 405927c9 interim: the served .pkg's freshness stamp (written by
  // build-pkg.sh at publish time, bypassed by the service worker). Absent or
  // stale → the one-line installer is the primary path and the pkg download is
  // not offered; a fetch failure stays silent and de-features the pkg. The
  // stamp lives NEXT TO the pkg (PKG_URL may point off-origin on self-hosts).
  const [pkgStamp, setPkgStamp] = useState<{ agentVersion?: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${PKG_URL}.json`, { cache: 'no-store' });
        if (!res.ok) return;
        const stamp = await res.json();
        if (!cancelled && stamp && typeof stamp === 'object') setPkgStamp(stamp);
      } catch { /* no stamp → the pkg stays de-featured */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const pkgFresh = pkgStampIsFresh(pkgStamp, status?.latestAgentVersion);
  // Pairing-code lifetime (ticket 205c6a42): when expiresInSec elapses we stop
  // polling and show an actionable "expired — generate a new one" state instead
  // of spinning forever.
  const [pairExpiresAt, setPairExpiresAt] = useState<number | null>(null);
  const [pairExpired, setPairExpired] = useState(false);
  // Multi-Mac (2026-09-24): pairing Mac #2 must ALSO close the dialog. The old
  // close condition was `s.connected` — already true before the second pair, so
  // the dialog spun forever. We capture the agent count when the dialog opens
  // and close when it INCREASES.
  const [pairBaselineCount, setPairBaselineCount] = useState(0);

  const [chats, setChats] = useState<IMessageChat[]>([]);
  const [loadingChats, setLoadingChats] = useState(false);
  const [activeChat, setActiveChat] = useState<IMessageChat | null>(null);
  const [messages, setMessages] = useState<IMessageMessage[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  const [sendTo, setSendTo] = useState('');
  const [sendText, setSendText] = useState('');
  const [sending, setSending] = useState(false);

  // Multi-Mac: which Mac the read/send panel addresses (default target).
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null);

  // Permission onboarding (ticket 2f646c10): per-agent busy flag + inline
  // dispatch error for the Open System Settings / Reveal / Relaunch buttons.
  const [permBusyId, setPermBusyId] = useState<string | null>(null);
  const [permError, setPermError] = useState<string | null>(null);

  // Running inside the Digby desktop app? Then we can set the iMessage helper up
  // in one click (the app bundles the agent) instead of downloading a .pkg.
  const [isDesktop, setIsDesktop] = useState(false);
  // Windows shell (2026-10-06): same bundled-agent one-click setup, different
  // copy — the Windows agent pairs via env vars (no code paste, no Full Disk
  // Access prompt) and has no iMessage bridge (W0), so the card's Windows
  // branch pitches browser + computer use only. __digbyDesktop.platform is
  // the discriminator; macOS leaves it unset.
  const [isWindows, setIsWindows] = useState(false);
  // Windows BROWSER detection (reviewer re-round MAJOR 1, 2026-10-25): the
  // isWindows flag above is SHELL-only — the Windows shell injects
  // __digbyDesktop.platform together with canSetupIMessage (Bridge.cs), so in a
  // plain Windows browser isWindows is always false and a setup-section gate on
  // it can never render (the user got the macOS bash one-liner + "open the
  // Terminal app" on a PC). The setup section therefore gates on the UA via
  // detectPlatform — the same helper the download page's PlatformCta uses.
  const [isWindowsBrowser, setIsWindowsBrowser] = useState(false);
  const [settingUp, setSettingUp] = useState(false);

  useEffect(() => {
    const d = (window as any).__digbyDesktop;
    setIsDesktop(Boolean(d && d.canSetupIMessage));
    setIsWindows(d?.platform === 'windows');
    setIsWindowsBrowser(detectPlatform(navigator.userAgent, navigator.maxTouchPoints) === 'windows');
  }, []);

  // Ask the native shell to install + start the bundled agent (pairing code rides
  // along so it connects silently; the agent then prompts for Full Disk Access).
  const setupOnThisMac = () => {
    try {
      (window as any).webkit?.messageHandlers?.digby?.postMessage({
        type: 'setupIMessage',
        pairingCode,
        apiBase: `${window.location.origin}/api`,
      });
      setSettingUp(true);
      toast.success(isWindows ? 'Setting up the Digby agent on this PC…' : 'Setting up iMessage on this Mac…');
    } catch {
      toast.error('Could not start setup automatically.');
    }
  };

  const fetchStatus = useCallback(async () => {
    try {
      setStatus(await imessageApi.getStatus());
      setLoadError(false);
    } catch {
      // Leave previous status if we had one; if the FIRST load failed, say so
      // instead of rendering the "not connected" pitch over an errored fetch.
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // 933e6ca4 (b): the agent restarts during a self-update (kickstart -k
  // replaces the running instance) and the desktop-app UI used to sit on the
  // LAST status until a manual refresh — the card showed Offline for the
  // whole restart window and the owner read that as "the update broke the
  // connection". Reconnect-aware live status: a slow always-on poll (paused
  // when the tab is hidden — a background tab cannot see the card anyway)
  // that refreshes the moment the agent comes back. Status-CHANGE gating
  // keeps it cheap: an unchanged payload never re-renders the tree. The
  // signature covers every field the render reads (reviewer round 2: the
  // first draft gated on connected/online/versions only, so a newly
  // deployed release would leave an open page showing "up to date").
  usePolling(
    async (signal) => {
      try {
        const s = await imessageApi.getStatus({ signal });
        if (signal.aborted) return;
        setStatus((prev) => {
          if (!prev || !s) return s ?? prev;
          const changed =
            prev.connected !== s.connected ||
            prev.latestAgentVersion !== s.latestAgentVersion ||
            prev.defaultAgentId !== s.defaultAgentId ||
            (prev.agents?.length ?? 0) !== (s.agents?.length ?? 0) ||
            (prev.agents ?? []).some((a, i) => {
              const b = s.agents?.[i];
              return !b || a.online !== b.online || a.agentVersion !== b.agentVersion ||
                a.label !== b.label || a.name !== b.name ||
                a.localBrowser?.available !== b.localBrowser?.available ||
                a.localBrowser?.status !== b.localBrowser?.status ||
                a.computerUse?.available !== b.computerUse?.available ||
                a.computerUse?.status !== b.computerUse?.status ||
                a.permissions?.sr !== b.permissions?.sr || a.permissions?.ax !== b.permissions?.ax ||
                a.permissions?.fda !== b.permissions?.fda || a.permissions?.relaunch !== b.permissions?.relaunch;
            });
          return changed ? s : prev;
        });
      } catch {
        /* transient — keep the last good status; the next tick retries */
      }
    },
    { intervalMs: 15_000, enabled: !loading, immediate: false, pauseWhenHidden: true },
  );

  // While the pairing dialog is open, poll status until the Mac connects — or
  // the pairing code expires (then STOP: no infinite spinner, ticket 205c6a42).
  // usePolling (P5): abortable ticks; `enabled` stops the poll when the dialog
  // closes or the code expires; always-on while pairing (the user is off in
  // the installer — the connect must be caught even in a background tab).
  // Multi-Mac (2026-09-24): close when the paired count INCREASES past the
  // baseline captured at dialog open — `s.connected` alone would never fire
  // for Mac #2 (it was already true).
  usePolling(
    async (signal) => {
      if (pairExpiresAt && Date.now() >= pairExpiresAt) {
        setPairExpired(true); // flips `enabled` false — the poll stops
        return;
      }
      try {
        const s = await imessageApi.getStatus({ signal });
        if (signal.aborted) return;
        setStatus(s);
        const count = s.agents?.length ?? (s.connected ? 1 : 0);
        if (count > pairBaselineCount || (!pairBaselineCount && s.connected)) {
          toast.success(
            isWindows
              ? count > 1 ? 'PC connected!' : 'Your PC is connected!'
              : count > 1 ? 'Mac connected! 💬' : 'Your Mac is connected! 💬',
          );
          setPairOpen(false);
        }
      } catch {
        /* keep polling */
      }
    },
    { intervalMs: 3000, enabled: pairOpen && !pairExpired, immediate: false, pauseWhenHidden: false },
  );

  // Ticket 2f646c10: does ANY Mac need permission attention? (a missing grant
  // or a pending relaunch). Drives the 3s live-refresh poll below — healthy
  // cards (and Windows agents, which never carry a permissions payload) stay
  // quiet, so the fast poll costs nothing when everything is fine.
  const permAgents = status?.agents ?? [];
  const permAttention = permAgents.some((a) =>
    a.platform !== 'windows' && a.permissions &&
    (!a.permissions.ax || !a.permissions.sr || !a.permissions.fda ||
      a.permissions.cal === false || a.permissions.relaunch),
  );

  // Live permission polling (ticket 2f646c10): while a Mac's permission
  // checklist shows anything missing (or a relaunch pending), refresh status
  // every 3s so the chips flip live as the user grants each permission in
  // System Settings. Same abortable usePolling as the pairing poll; `enabled`
  // is a DERIVED boolean so a healthy (or unexpanded) card costs nothing.
  usePolling(
    async (signal) => {
      try {
        const s = await imessageApi.getStatus({ signal });
        if (!signal.aborted) setStatus(s);
      } catch {
        /* keep polling — a transient failure must not freeze the checklist */
      }
    },
    { intervalMs: 3000, enabled: permAttention, immediate: false, pauseWhenHidden: false },
  );

  const handleStartPairing = async () => {
    setPairing(true);
    setSettingUp(false);
    try {
      const { pairingCode, expiresInSec } = await imessageApi.startPairing();
      setPairingCode(pairingCode);
      setPairExpiresAt(Date.now() + (Number(expiresInSec) > 0 ? Number(expiresInSec) : 600) * 1000);
      setPairExpired(false);
      // Multi-Mac: baseline the device count so Mac #2 (count increase) closes.
      setPairBaselineCount(status?.agents?.length ?? (status?.connected ? 1 : 0));
      setPairOpen(true);
    } catch {
      toast.error('Could not start pairing — please try again.');
    } finally {
      setPairing(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await imessageApi.disconnect();
      setStatus({ connected: false, online: false });
      setChats([]);
      setActiveChat(null);
      setMessages([]);
      setActiveDeviceId(null);
      toast.success(isWindows ? 'PC disconnected' : 'Mac disconnected');
    } catch {
      toast.error('Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  };

  // ── Multi-Mac per-device management ─────────────────────────────────────────

  const agents = status?.agents ?? [];
  const activeAgent =
    agents.find((a) => a.id === activeDeviceId)
    ?? agents.find((a) => a.id === status?.defaultAgentId)
    ?? agents[0]
    ?? null;

  const handleDeviceDisconnect = async (id: string) => {
    setDeviceBusy(id);
    try {
      await imessageApi.disconnectAgent(id);
      const s = await imessageApi.getStatus();
      setStatus(s);
      if (activeDeviceId === id) {
        setActiveDeviceId(null);
        setChats([]);
        setActiveChat(null);
        setMessages([]);
      }
      toast.success(isWindows ? 'PC disconnected' : 'Mac disconnected');
    } catch {
      toast.error('Failed to disconnect that Mac');
    } finally {
      setDeviceBusy(null);
    }
  };

  const handleRename = async (id: string) => {
    if (!renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    setDeviceBusy(id);
    try {
      await imessageApi.renameAgent(id, renameValue.trim());
      const s = await imessageApi.getStatus();
      setStatus(s);
      setRenamingId(null);
      toast.success('Renamed');
    } catch {
      toast.error('Failed to rename');
    } finally {
      setDeviceBusy(null);
    }
  };

  const handleMakeDefault = async (id: string) => {
    setDeviceBusy(id);
    try {
      await imessageApi.setDefaultAgent(id);
      const s = await imessageApi.getStatus();
      setStatus(s);
      toast.success('Default Mac updated');
    } catch {
      toast.error('Failed to set the default Mac');
    } finally {
      setDeviceBusy(null);
    }
  };

  // ── Permission onboarding (ticket 2f646c10, agent ≥ 0.6.0) ──────────────────
  // The three card buttons dispatch to the paired Mac; a relaunch refreshes the
  // status right after (launchd restarts the helper from the CURRENT bundle in
  // ~10s, which re-advertises its TCC state — the user should see the chips
  // flip without hunting for a refresh).
  const handlePermissionAction = async (
    id: string,
    action: 'relaunch' | 'open-pane' | 'reveal',
    pane?: 'accessibility' | 'screen-recording' | 'full-disk-access' | 'calendars',
  ) => {
    setPermBusyId(id);
    setPermError(null);
    try {
      await imessageApi.permissionAction(id, action, pane);
      if (action === 'relaunch') {
        toast.success('Relaunching the helper — status updates in ~10s');
        // The helper is bouncing; refresh shortly so the chips reflect the
        // restarted state without the user doing anything.
        setTimeout(() => { fetchStatus(); }, 12_000);
      }
    } catch (e: any) {
      const msg = e?.response?.data?.error || e?.message || 'The Mac did not respond';
      setPermError(msg);
      toast.error(msg);
    } finally {
      setPermBusyId(null);
    }
  };

  const loadChats = async () => {
    setLoadingChats(true);
    try {
      setChats(await imessageApi.getChats(20, activeAgent?.name || undefined));
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not load conversations');
    } finally {
      setLoadingChats(false);
    }
  };

  const openChat = async (chat: IMessageChat) => {
    setActiveChat(chat);
    setLoadingMessages(true);
    setMessages([]);
    try {
      setMessages(await imessageApi.getMessages(chat.identifier || String(chat.chatId), 25, activeAgent?.name || undefined));
      if (!sendTo) setSendTo(chat.identifier);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not load messages');
    } finally {
      setLoadingMessages(false);
    }
  };

  const handleSend = async () => {
    if (!sendTo.trim() || !sendText.trim()) {
      toast.error('Enter a recipient and a message');
      return;
    }
    setSending(true);
    try {
      await imessageApi.send(sendTo.trim(), sendText.trim(), activeAgent?.name || undefined);
      toast.success(`Message sent 📤${activeAgent ? ` via ${activeAgent.name || activeAgent.label}` : ''}`);
      setSendText('');
      if (activeChat && activeChat.identifier === sendTo.trim()) openChat(activeChat);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const connected = status?.connected;
  const online = status?.online;
  // Self-host setup hardening (2026-10-20): the one-liner is built from the
  // page's OWN origin — the script, the tarball and the pairing API all come
  // from this instance (the installer's own defaults point at production, so
  // a self-host user used to pair their Mac against digby.example.com). On production
  // the origin IS digby.example.com, so the command is the same as before.
  const installOrigin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : INSTALL_HOST;
  // Production (the page origin IS the install host) keeps the byte-identical
  // one-liners; any other origin is a self-host, whose Macs must fetch the
  // installer + agent from it and pair against its /api — never digby.example.com.
  const selfHostOrigin = installOrigin.replace(/\/+$/, '') !== INSTALL_HOST.replace(/\/+$/, '');
  const installCmd = selfHostOrigin
    ? macAgentInstallCommand(installOrigin, pairingCode || 'YOUR-CODE')
    : `curl -fsSL ${INSTALL_HOST}/install-digby-agent.sh | bash -s -- ${pairingCode || 'YOUR-CODE'}`;
  // Ticket 31fd8440: the UPDATE one-liner — no pairing code. An already-paired
  // Mac (config.json exists) skips pairing and reinstalls the CURRENT release;
  // the installer writes the .digby-selfupdate marker, so the agent keeps
  // itself current from then on. install.sh's pair guard handles both cases.
  const updateCmd = selfHostOrigin
    ? macAgentUpdateCommand(installOrigin)
    : `curl -fsSL ${INSTALL_HOST}/install-digby-agent.sh | bash -s -- --update-only`;

  return (
    <div className="rounded-lg border p-4" data-mac-agent-card>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Laptop className="size-5 text-brand-accent" />
          <span className="text-sm font-semibold">Mac agent</span>
          {connected && (
            <Badge variant="outline" className="h-5 gap-1 text-[10px]">
              <span className={cnDot(online)} />
              {online ? 'Online' : 'Offline'}
            </Badge>
          )}
        </div>

        {loading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : connected ? (
          // REVIEW B2 (multi-Mac): this header button revokes ALL paired Macs
          // (legacy /disconnect). With several Macs the per-device Disconnect
          // in each device block is the primary action — hide the global one so
          // "Disconnect this Mac" copy can never nuke a sibling pairing.
          agents.length > 1 ? null : (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs text-destructive hover:text-destructive border-destructive/40"
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Unlink className="size-3.5 mr-1" />
                )}{' '}
                Disconnect
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect this {isWindows ? 'PC' : 'Mac'}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Digby will no longer be able to read or send iMessages from this Mac. You can
                  re-pair anytime. (To fully stop the agent, also quit it on your Mac.)
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleDisconnect}>Disconnect</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          )
        ) : (
          <Button
            size="sm"
            className="h-7 text-xs gap-1.5"
            disabled={pairing}
            onClick={handleStartPairing}
          >
            {pairing ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}{' '}
            {isWindows ? 'Connect your PC' : 'Connect your Mac'}
          </Button>
        )}
      </div>

      {/* Body */}
      {!loading && status === null && loadError ? (
        <LoadErrorState
          className="py-4"
          message="Couldn't load the iMessage connection status."
          onRetry={() => { setLoading(true); fetchStatus(); }}
        />
      ) : !connected ? (
        <div className="mt-2 space-y-3">
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {isWindows ? (
              <>
                Run the Digby agent on your PC and one pairing gives Digby two things: a real
                browser on your PC for web tasks that need a logged-in session, and computer use —
                Digby seeing and driving your actual screen. The agent runs locally in the
                background — nothing leaves your machine except what you ask about. Click{' '}
                <strong>Connect your PC</strong> to start.
              </>
            ) : (
              <>
                Run the Digby agent on your Mac and one pairing gives Digby three things: your
                iMessages (read and send), a real browser on your Mac for web tasks that need a
                logged-in session, and computer use — Digby seeing and driving your actual screen. The
                agent runs locally in the background — nothing leaves your machine except what you ask
                about. Click <strong>Connect your Mac</strong> to get a pairing code.
              </>
            )}
          </p>
          <div className={`grid gap-1.5 ${isWindows ? 'grid-cols-2' : 'grid-cols-3'}`}>
            {([
              { icon: MessageCircle, label: 'iMessage', desc: 'Read & send' },
              { icon: Globe, label: 'Browser', desc: 'Logged-in web tasks' },
              { icon: Monitor, label: 'Computer use', desc: 'See & drive your Mac' },
            ] as const)
              // Windows (W0): no iMessage bridge — the card pitches browser + computer use.
              .filter((item) => !isWindows || item.label !== 'iMessage')
              .map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex items-center gap-2 rounded-lg border border-dashed border-muted-foreground/20 px-2.5 py-2">
                <Icon className="size-3.5 text-muted-foreground/60 flex-shrink-0" />
                <div><p className="text-[11px] font-medium">{label}</p><p className="text-[10px] text-muted-foreground">{isWindows && desc === 'See & drive your Mac' ? 'See & drive your PC' : desc}</p></div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          {/* Multi-Mac (2026-09-24): one block per paired Mac — ITS presence,
              capabilities, and management (rename / make-default / disconnect).
              Single-Mac users see exactly one block; when the backend hasn't
              sent agents[] yet (old backend), the legacy aggregate fields
              render the same card as before. */}
          {agents.length === 0 && (
            <div className="space-y-2">
              <div className="text-[11px] text-muted-foreground">
                {status?.deviceName ? <span className="font-medium">{status.deviceName}</span> : isWindows ? 'Paired PC' : 'Paired Mac'}
                {status?.lastSeenAt && <> · last seen {fmtTime(status.lastSeenAt)}</>}
              </div>
              {!online && (
                <p className="text-[11px] text-warn-ink">
                  {isWindows
                    ? 'Your PC agent is offline. Make sure the Digby agent is running on your PC.'
                    : 'Your Mac agent is offline. Make sure the Digby agent is running on your Mac.'}
                </p>
              )}
              <div className={`grid gap-1.5 ${isWindows ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`} data-mac-capabilities>
                {!isWindows && (
                  <div className="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[11px]" title={online ? 'iMessage bridge online' : 'iMessage bridge offline — start the Digby agent on your Mac'}>
                    <span className={cnDot(online)} />
                    <MessageCircle className="size-3.5 text-[#34da50] flex-shrink-0" />
                    <span className="min-w-0 truncate"><span className="font-medium">iMessage</span> · {online ? 'online' : 'offline'}</span>
                  </div>
                )}
                {status?.localBrowser && (
                  <div className="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[11px]" title={status.localBrowser.status}>
                    <span className={cnDot(status.localBrowser.available)} />
                    <Globe className="size-3.5 text-brand-accent flex-shrink-0" />
                    <span className="min-w-0 truncate"><span className="font-medium">Browser</span> · {status.localBrowser.available ? 'available on this Mac' : 'cloud (read-only)'}</span>
                  </div>
                )}
                {status?.computerUse && (
                  <div className="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[11px]" title={status.computerUse.status}>
                    <span className={cnDot(status.computerUse.available)} />
                    <Monitor className="size-3.5 flex-shrink-0" />
                    <span className="min-w-0 truncate"><span className="font-medium">Computer use</span> · {status.computerUse.available ? 'ready' : 'not available'}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {agents.map((a) => {
            const isWin = a.platform === 'windows';
            const name = a.name || a.label || a.deviceName || (isWin ? 'PC' : 'Mac');
            const osNoun = isWin ? 'PC' : 'Mac';
            const isDefault = a.isDefault || a.id === status?.defaultAgentId;
            const isActive = activeAgent?.id === a.id;
            return (
              <div
                key={a.id}
                className={`rounded-lg border p-2.5 space-y-2 ${isActive && agents.length > 1 ? 'border-brand-accent/50' : ''}`}
                data-mac-device={name}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cnDot(a.online)} />
                    {renamingId === a.id ? (
                      <span className="flex items-center gap-1.5 min-w-0">
                        <Input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRename(a.id);
                            if (e.key === 'Escape') setRenamingId(null);
                          }}
                          className="h-6 w-36 text-xs"
                          maxLength={60}
                        />
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" disabled={deviceBusy === a.id} onClick={() => handleRename(a.id)}>Save</Button>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => setRenamingId(null)}>Cancel</Button>
                      </span>
                    ) : (
                      <button
                        className="text-xs font-medium truncate hover:underline underline-offset-2"
                        title={`Rename this ${osNoun}`}
                        onClick={() => { setRenamingId(a.id); setRenameValue(name); }}
                      >
                        {name}
                      </button>
                    )}
                    {isDefault && (
                      <Badge variant="outline" className="h-4 px-1.5 text-[9px] text-muted-foreground">Default</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {!isDefault && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[10px]"
                        disabled={deviceBusy === a.id}
                        onClick={() => handleMakeDefault(a.id)}
                        title={isWin ? 'Make this the default PC for tasks' : 'Make this the default Mac for tasks'}
                      >
                        Make default
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px] text-destructive hover:text-destructive"
                      disabled={deviceBusy === a.id}
                      onClick={() => handleDeviceDisconnect(a.id)}
                    >
                      {deviceBusy === a.id ? <Loader2 className="size-3 animate-spin" /> : <Unlink className="size-3 mr-1" />}
                      Disconnect
                    </Button>
                  </div>
                </div>

                <div className="text-[10px] text-muted-foreground">
                  {a.online ? 'Online' : 'Offline'}
                  {a.lastSeenAt && <> · last seen {fmtTime(a.lastSeenAt)}</>}
                  {a.agentVersion && <> · agent v{a.agentVersion}</>}
                </div>

                {/* Ticket 31fd8440 — the owner re-downloaded the desktop app and
                    still had an old agent: re-downloading does NOT update the Mac
                    agent (the .app bundles its own copy), so show a version the
                    user can ACT on. Rendered when this Mac's agent is strictly
                    older than the current released agent (backend manifest). */}
                <AgentUpdateHint
                  agentVersion={a.agentVersion}
                  latest={status?.latestAgentVersion}
                  platform={a.platform}
                  updateCmd={updateCmd}
                />

                <div className="grid gap-1.5 sm:grid-cols-3" data-mac-capabilities>
                  <div className="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[11px]" title={a.online ? 'iMessage bridge online' : isWin ? 'Not available on Windows' : 'iMessage bridge offline — start the Digby agent on this Mac'}>
                    <span className={cnDot(a.online && !isWin)} />
                    <MessageCircle className="size-3.5 text-[#34da50] flex-shrink-0" />
                    <span className="min-w-0 truncate"><span className="font-medium">iMessage</span> · {isWin ? 'not on Windows' : a.online ? 'online' : 'offline'}</span>
                  </div>
                  {a.localBrowser && (
                    <div className="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[11px]" title={a.localBrowser.status}>
                      <span className={cnDot(a.localBrowser.available)} />
                      <Globe className="size-3.5 text-brand-accent flex-shrink-0" />
                      <span className="min-w-0 truncate"><span className="font-medium">Browser</span> · {a.localBrowser.available ? `available on this ${osNoun}` : 'cloud (read-only)'}</span>
                    </div>
                  )}
                  {a.computerUse && (
                    <div className="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[11px]" title={a.computerUse.status}>
                      <span className={cnDot(a.computerUse.available)} />
                      <Monitor className="size-3.5 flex-shrink-0" />
                      <span className="min-w-0 truncate"><span className="font-medium">Computer use</span> · {a.computerUse.available ? 'ready' : 'not available'}</span>
                    </div>
                  )}
                </div>

                {/* macOS permission checklist (ticket 2f646c10, agent ≥ 0.6.0).
                    Windows agents never advertise TCC state — no section. */}
                {a.platform !== 'windows' && (
                  <MacPermissionsSection
                    agent={a}
                    busy={permBusyId === a.id}
                    error={permError}
                    onAction={(action, pane) => handlePermissionAction(a.id, action, pane)}
                  />
                )}

                {/* Remote control health line (ticket c468f922): the pre-login
                    capability + the brokered-channel three-state line, per
                    device, for the owner. Read-only by design — enabling is
                    root-on-the-device work the paired agent cannot do, so the
                    section prints the command instead of a button that would
                    fail. See RemoteControlSection's header. */}
                <RemoteControlSection agent={a} />

                {agents.length > 1 && (
                  <Button
                    variant={isActive ? 'secondary' : 'outline'}
                    size="sm"
                    className="h-6 w-full text-[10px]"
                    disabled={!a.online}
                    onClick={() => { setActiveDeviceId(a.id); setChats([]); setActiveChat(null); setMessages([]); }}
                  >
                    {isActive ? `Reading from this ${osNoun}` : a.online ? `Use this ${osNoun} for conversations` : 'Offline'}
                  </Button>
                )}
              </div>
            );
          })}

          {/* Connect ANOTHER Mac — always available once one is paired. */}
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full text-xs gap-1.5"
            disabled={pairing}
            onClick={handleStartPairing}
          >
            {pairing ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}{' '}
            {agents.length > 0
              ? isWindows ? 'Connect another PC' : 'Connect another Mac'
              : isWindows ? 'Connect your PC' : 'Connect your Mac'}
          </Button>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium">Recent conversations</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[11px]"
                disabled={loadingChats || !online}
                onClick={loadChats}
              >
                {loadingChats ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RefreshCw className="size-3 mr-1" />
                )}{' '}
                Load
              </Button>
            </div>
            {chats.length > 0 && (
              <div className="rounded-md border divide-y max-h-44 overflow-y-auto">
                {chats.map((c) => (
                  <button
                    key={c.chatId}
                    onClick={() => openChat(c)}
                    className="w-full text-left px-2.5 py-1.5 hover:bg-muted/60 transition-colors"
                  >
                    <div className="text-xs font-medium truncate">
                      {c.displayName || c.identifier}
                    </div>
                    {c.lastMessage && (
                      <div className="text-[11px] text-muted-foreground truncate">{c.lastMessage}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Messages of the active chat */}
          {activeChat && (
            <div>
              <div className="text-xs font-medium mb-1.5">
                {activeChat.displayName || activeChat.identifier}
              </div>
              {loadingMessages ? (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Loading messages…
                </div>
              ) : (
                <div className="rounded-md border p-2 space-y-1.5 max-h-52 overflow-y-auto">
                  {messages.length === 0 && (
                    <div className="text-[11px] text-muted-foreground">No messages.</div>
                  )}
                  {messages
                    .slice()
                    .reverse()
                    .map((m) => (
                      <div
                        key={m.id}
                        className={`text-[11px] leading-snug ${m.fromMe ? 'text-right' : 'text-left'}`}
                      >
                        <span
                          className={`inline-block rounded-lg px-2 py-1 max-w-[85%] ${
                            m.fromMe ? 'bg-[#34da50]/15' : 'bg-muted'
                          }`}
                        >
                          {m.text}
                        </span>
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {/* Compose */}
          <div className="space-y-2">
            <span className="text-xs font-medium">Send a message</span>
            <Input
              value={sendTo}
              onChange={(e) => setSendTo(e.target.value)}
              placeholder="To (phone or email, e.g. +15551234567)"
              className="h-8 text-xs"
            />
            <textarea
              value={sendText}
              onChange={(e) => setSendText(e.target.value)}
              placeholder="Type a message…"
              rows={2}
              className="w-full rounded-md border bg-transparent px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring resize-y"
            />
            <Button
              size="sm"
              className="h-7 text-xs gap-1.5"
              disabled={sending || !online}
              onClick={handleSend}
            >
              {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}{' '}
              Send iMessage
            </Button>
          </div>
        </div>
      )}

      {/* Pairing dialog — beginner-friendly one-liner flow */}
      <Dialog open={pairOpen} onOpenChange={setPairOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{isWindows ? 'Connect your PC' : 'Connect your Mac'}</DialogTitle>
            <DialogDescription>
              {isWindows
                ? 'No technical setup — one click and Digby connects this PC.'
                : 'No technical setup — just copy, paste, and allow one permission.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* In-app one-click setup — the desktop app bundles the agent, so there's
                nothing to download and no pairing code to paste. */}
            {isDesktop && (
              <div>
                <p className="text-xs font-medium mb-1.5">{isWindows ? 'Set up the Digby agent on this PC' : 'Set up iMessage on this Mac'}</p>
                <Button
                  size="sm"
                  className="w-full h-9 text-xs gap-1.5"
                  onClick={setupOnThisMac}
                  disabled={settingUp || !pairingCode}
                >
                  {settingUp ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <MessageCircle className="size-4" />
                  )}{' '}
                  {settingUp ? 'Setting up…' : isWindows ? 'Set up the Digby agent on this PC' : 'Set up iMessage on this Mac'}
                </Button>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  {isWindows
                    ? 'One click — Digby starts its bundled agent and connects it to your account. No permission prompts on Windows.'
                    : <>
                        One click — Digby installs its helper and connects. When macOS asks, allow{' '}
                        <strong>Full Disk Access</strong> (one switch) so Digby can read your Messages.
                      </>}
                </p>
                {/* 4b413b07: the code the Mac-side prompt asks for, visible even
                    in the one-click branch. Windows pairs via env vars (no code
                    is ever asked for), so the box is Mac-only. */}
                {!isWindows && (
                  <div className="mt-2">
                    <p className="text-[11px] text-muted-foreground mb-1">
                      Asked for a pairing code on this Mac? It&apos;s this:
                    </p>
                    <PairingCodeBox
                      pairingCode={pairingCode}
                      onCopy={() => {
                        navigator.clipboard.writeText(pairingCode);
                        toast.success('Copied');
                      }}
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      The one-click button above is still the easiest path — this code is for the
                      manual install (or if the Mac asks and the click path didn&apos;t connect).
                      Expires in 10 minutes.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Zero-Terminal flow — only while the served .pkg is STAMPED FRESH
                (405927c9 interim: build-pkg.sh publishes <pkg>.json alongside
                the pkg; an unstamped or stale pkg is de-featured to the
                one-line installer below, which always installs the current
                release). Mac-only: Windows users get the one-installer app
                pointer further down. */}
            {!isDesktop && !isWindowsBrowser && pkgFresh && (
              <>
                <div>
                  <p className="text-xs font-medium mb-1.5">1. Download &amp; open the installer</p>
                  <a href={PKG_URL} download>
                    <Button size="sm" className="w-full h-9 text-xs gap-1.5">
                      <Download className="size-4" /> Download the Digby installer (.pkg)
                    </Button>
                  </a>
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Double-click it and click through — nothing else to install.
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium mb-1.5">2. When it asks, paste this pairing code</p>
                  <PairingCodeBox
                    pairingCode={pairingCode}
                    onCopy={() => {
                      navigator.clipboard.writeText(pairingCode);
                      toast.success('Copied');
                    }}
                  />
                  <p className="text-[11px] text-muted-foreground mt-1.5">
                    Then allow <strong>Full Disk Access</strong> when prompted (one switch). Code
                    expires in 10 minutes.
                  </p>
                </div>
              </>
            )}

            {/* Terminal one-liner flow (the default whenever the .pkg isn't
                stamped fresh). Mac-only — Windows browser users get the app
                pointer below instead (the command is a macOS/bash one-liner). */}
            {!isDesktop && !isWindowsBrowser && !pkgFresh && (
              <>
            {/* Step 1 */}
            <div>
              <p className="text-xs font-medium">
                1. On your Mac, open the <strong>Terminal</strong> app
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Press{' '}
                <kbd className="px-1 py-0.5 rounded border bg-muted text-[10px] font-mono">⌘ Space</kbd>,
                type “Terminal”, then press Return.
              </p>
            </div>

            {/* Step 2 — the one-liner */}
            <div>
              <p className="text-xs font-medium mb-1.5">2. Paste this, then press Return</p>
              <div className="relative rounded-lg border bg-muted/50 p-3 pr-11">
                <code className="block text-[11px] font-mono break-all leading-relaxed">
                  {installCmd}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute top-1.5 right-1.5 size-7 p-0"
                  onClick={() => {
                    navigator.clipboard.writeText(installCmd);
                    toast.success('Copied — now paste it into Terminal');
                  }}
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5">
                It installs everything, then opens <strong>one</strong> System Settings switch
                (Full Disk Access) for you to turn on. The code expires in 10 minutes.
              </p>
            </div>
              </>
            )}

            {/* 405927c9 interim: a .pkg IS published but not stamped fresh
                (or the stamp is unreadable) — say the click-through installer
                is mid-refresh instead of offering the older build. No link:
                the one-liner above installs the current release today. */}
            {!isDesktop && !isWindowsBrowser && !pkgFresh && (
              <p className="text-[11px] text-muted-foreground">
                The click-through installer is being refreshed — the command above installs the
                current agent today.
              </p>
            )}

            {/* Windows browser users (UA-detected — the __digbyDesktop flag is
                shell-only and never set here): the .pkg/Terminal flows above
                are macOS — on Windows the ONE installer (Digby-Setup.exe)
                already bundles the agent (default-on component); pair from
                inside the app. */}
            {!isDesktop && isWindowsBrowser && (
              <p className="text-[11px] text-muted-foreground">
                On Windows the Digby app includes the agent —{' '}
                <a href="/Digby-Setup.exe" download className="underline underline-offset-2">
                  download the Digby installer for Windows
                </a>
                , open it, then use <strong>Set up on this PC</strong> inside the app.
              </p>
            )}

            {pairExpired ? (
              /* Actionable expired state (ticket 205c6a42) — polling has stopped. */
              <div className="rounded-lg border border-warn/60 bg-warn/10 p-3 space-y-2 text-center">
                <p className="text-xs font-medium text-warn-ink">
                  Pairing code expired — generate a new one.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  disabled={pairing}
                  onClick={handleStartPairing}
                >
                  {pairing ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3.5" />
                  )}{' '}
                  Generate a new code
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Still not connecting? Make sure the Digby agent is actually running on your {isWindows ? 'PC' : 'Mac'}.
                </p>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Waiting for your {isWindows ? 'PC' : 'Mac'} to connect…
              </div>
            )}

            <div className="text-center">
              <a
                href={AGENT_DOWNLOAD_URL}
                download
                className="text-[11px] text-muted-foreground underline hover:text-foreground"
              >
                Prefer to install manually? Download the agent
              </a>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function cnDot(online?: boolean): string {
  return `inline-block size-1.5 rounded-full ${online ? 'bg-success-accent' : 'bg-muted-foreground/50'}`;
}

// ── Remote control: pre-login helper + brokered channel (ticket c468f922) ────
//
// WHAT THE OWNER ASKED FOR (2026-10-28): "how can you fix this for all mac and
// windows clients to give full remote login permissions etc as this will be a
// requirement for most users to use their remote devices autonomously".
//
// WHAT THIS SECTION HONESTLY REPORTS. Two SEPARATE facts, never merged:
//   • `prelogin`     — can THIS agent's input land while no user session
//                      exists? `unavailable` in this build: no privileged
//                      helper ships (a root LaunchDaemon / LocalSystem service
//                      would be needed). When one ships, its install probe
//                      flips this and the row turns green with no UI change.
//   • `remoteAccess` — does a hardened OPERATOR channel exist (macOS Screen
//                      Sharing / Windows RDP, tunnel-scoped)? `off` is the
//                      HEALTHY default: opt-in, nothing listening. It is not a
//                      fault and must never be nagged about.
//
// WHY THERE IS NO ENABLE TOGGLE HERE. Enabling the channel drives ARDAgent's
// `kickstart`, a root-owned PF anchor and `pfctl` (macOS) or TermService and a
// firewall rule (Windows). The paired agent runs as the LOGGED-IN USER and has
// no dispatchable command for it — its broker vocabulary is
// `permission_relaunch` / `permission_open_pane` only. A button that cannot
// perform its action is precisely the defect class this ticket exists to end
// (a c468f922-era notice told lanes to "reach the device through it" when no
// RFB/RDP client existed at all — corrected in #2144). So this renders the ONE
// command that DOES work, to be run by an operator at that device, and says so.
//
// The STATE wording is the contract from the backend leaf
// (`remote-access-verdict.ts`): `off` healthy, `on` usable, `blocked` fix the
// named blocker first, `unavailable` nothing was reported (do not assume).

const REMOTE_STATE_LABEL: Record<'off' | 'on' | 'blocked' | 'unavailable', string> = {
  off: 'off (healthy default)',
  on: 'on',
  blocked: 'blocked',
  unavailable: 'not reported',
};

/** The exact on-device command per platform — the ONLY working enable path. */
function remoteEnableCmd(platform: string | null | undefined): string {
  return platform === 'windows'
    ? 'digby-win-agent remote-access enable <dedicated-account>'
    : 'sudo digby-agent remote-access enable <account>';
}

/** The unattended preset's badge label per typed state (ticket 11b6974f).
 *  Deliberately NOT a single "not ready": `off` is a healthy opt-in default and
 *  `unavailable` is an agent-build gap — collapsing them is the defect. */
const UNATTENDED_STATE_LABEL: Record<'ready' | 'blocked' | 'off' | 'unavailable', string> = {
  ready: 'ready',
  blocked: 'blocked',
  off: 'off (not enabled)',
  unavailable: 'not reported',
};

function unattendedStateLabel(v: { state?: string; enabled: boolean }): string {
  const s = (v.state ?? (v.enabled ? 'blocked' : 'unavailable')) as keyof typeof UNATTENDED_STATE_LABEL;
  return UNATTENDED_STATE_LABEL[s] ?? 'not ready';
}

/** The exact preset command per platform (mirrors `unattendedEnableCmd` in
 *  backend/src/modules/crossmodel/imessage/unattended-verdict.ts — that one
 *  formats the reason text, this one renders the card line). */
export function unattendedEnableCmd(platform: string | null | undefined): string {
  return platform === 'windows' ? 'digby-win-agent unattended enable' : 'digby-agent unattended enable';
}

/**
 * Pure: renders only from the payload. No effects, no dispatch — so it is
 * SSR-renderable and pinned by the node-env vitest idiom this repo uses for
 * this card (see IMessageCard.permissions.2f646c10.test.tsx).
 */
export function RemoteControlSection({ agent }: { agent: IMessageAgentInfo }) {
  const pre = agent.prelogin;
  const remote = agent.remoteAccess;
  const unattended = agent.unattendedReady;
  const osNoun = agent.platform === 'windows' ? 'PC' : 'Mac';

  // Older backend (before these fields shipped): say so rather than invent a
  // state. An absent fact is an honest unknown, never a fabricated "off".
  if (!pre && !remote) {
    return (
      <div className="text-[11px] text-muted-foreground" data-testid="remote-control-legacy">
        Remote control: update the server to see lock-screen and remote-channel status.
      </div>
    );
  }

  const state = remote?.state ?? 'unavailable';
  return (
    <div className="space-y-1.5" data-testid="remote-control">
      {/* Locked RIGHT NOW is the actionable one — it refuses a dispatch. */}
      {pre?.blockedNow && (
        <div
          className="rounded-lg border border-warn/60 bg-warn/10 p-2"
          data-testid="remote-control-blocked-now"
        >
          <p className="text-[11px] text-warn-ink leading-snug">
            This {osNoun} is at a lock / login screen right now. Digby cannot type
            there, so tasks needing input are refused rather than retried — unlock it
            once and the next task lands.
          </p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2" data-testid="remote-control-prelogin">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={cnDot(pre?.status === 'available')} />
          <span className="text-[11px] truncate" title={pre?.reason}>
            Pre-login input
          </span>
        </span>
        <Badge variant="outline" className="h-4 px-1.5 text-[9px] flex-shrink-0 text-muted-foreground">
          {pre?.status === 'available' ? 'available' : 'unavailable'}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-2" data-testid="remote-control-channel">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={cnDot(state === 'on')} />
          <span className="text-[11px] truncate" title={remote?.reason}>
            Remote channel
          </span>
        </span>
        <Badge
          variant="outline"
          className={`h-4 px-1.5 text-[9px] flex-shrink-0 ${state === 'blocked' ? 'text-warn-ink' : 'text-muted-foreground'}`}
        >
          {REMOTE_STATE_LABEL[state]}
        </Badge>
      </div>

      {/* The blocker reason is what makes `blocked` actionable; for `off` we
          deliberately do NOT print a "turn it on" nag — that is the inversion
          the three-state line exists to prevent. */}
      {state === 'blocked' && remote?.reason && (
        <p className="text-[10px] text-warn-ink leading-snug" data-testid="remote-control-reason">
          {remote.reason}
        </p>
      )}

      {unattended && (
        <>
          <div className="flex items-center justify-between gap-2" data-testid="remote-control-unattended">
            <span className="flex items-center gap-1.5 min-w-0">
              <span className={cnDot(unattended.ready)} />
              <span className="text-[11px] truncate">Unattended use</span>
            </span>
            <Badge variant="outline" className="h-4 px-1.5 text-[9px] flex-shrink-0 text-muted-foreground">
              {unattended.ready ? 'ready' : unattendedStateLabel(unattended)}
            </Badge>
          </div>
          {/* TICKET 11b6974f: the REASON and the exact COMMAND.
              The badge alone said "not ready" for every non-ready device, so an
              owner could not tell "I never switched the preset on" (act on the
              device, this command) from "this agent build cannot report it"
              (act on the agent, update it) — and the fleet read the
              update-the-agent sentence on all five paired devices no matter
              what the owner toggled. The reason now names the state, and for
              the two states where a device command is the remedy it prints the
              exact per-platform one. */}
          {!unattended.ready && unattended.reason && (
            <p className="text-[10px] text-muted-foreground leading-snug" data-testid="remote-control-unattended-reason">
              {unattended.reason}
            </p>
          )}
          {unattended.state === 'off' && (
            <p className="text-[10px] text-muted-foreground leading-snug" data-testid="remote-control-unattended-enable-cmd">
              To let the fleet work on this {osNoun} with nobody signed in, run this once on the
              {' '}{osNoun} itself: <code className="font-mono">{unattendedEnableCmd(agent.platform)}</code>
            </p>
          )}
        </>
      )}

      {/* The ONE working enable path — offered ONLY in `off`.
          A state-gated command, not a blanket one, because the other states
          make "run remote-access enable" wrong or impossible:
            • `on`          — already enabled; nothing to run.
            • `blocked`     — it IS enabled (that is why a blocker can fire).
                              The remedy is the named blocker, or a revoke; a
                              second `enable` fixes nothing and would tell an
                              owner to re-run the thing already running.
            • `unavailable` — the agent never reported, which in practice means
                              it predates the command: `remote-access` shipped
                              in agent 0.9.12, so on 0.9.11 the printed command
                              simply does not exist. Telling an owner to run a
                              command their device cannot have is exactly the
                              defect #2144 had to correct — a path that cannot
                              work, presented as the remedy. Update first.
          Enabling is root-on-the-device work the agent cannot do on the
          owner's behalf, so this states the command without implying a click
          here would perform it. */}
      {state === 'off' && (
        <p className="text-[10px] text-muted-foreground leading-snug" data-testid="remote-control-enable-cmd">
          To let an operator reach this {osNoun} at the login window, run this once on the
          {' '}{osNoun} itself: <code className="font-mono">{remoteEnableCmd(agent.platform)}</code>
        </p>
      )}

      {/* `unavailable` is not a device fault and not an off device — it is an
          agent too old to answer. The honest next step is the update. */}
      {state === 'unavailable' && (
        <p className="text-[10px] text-muted-foreground leading-snug" data-testid="remote-control-update-agent">
          The agent on this {osNoun} is too old to report a remote channel — update it, then
          re-check here. Nothing is known to be listening.
        </p>
      )}
    </div>
  );
}

// ── Pairing code box (ticket 4b413b07, 2026-10-22) ───────────────────────────
//
// "new macbookpro no code>?" — the owner's NEW MacBook Pro showed the Mac
// agent's native prompt ("Enter your Digby pairing code. Get it from digby.example.com
// → Account → Integrations → iMessage → Connect your Mac"), but inside the
// DESKTOP app that exact dialog rendered no code anywhere: the desktop branch
// is one-click-only by design (the code rides in env DIGBY_PAIR_CODE), so a
// user whose bundled-agent path failed — or who opened the manual "Download
// the agent" link at the bottom of the same dialog, which NEEDS the code —
// was told to fetch a code from a dialog that never showed one.
//
// The code now renders in BOTH consumption branches (and stays as-is in the
// browser .pkg flow, where it always lived). The one-click button stays
// primary; the box is the fallback the Mac-side prompt points at.
//
// PURE presentational (AgentUpdateHint idiom) so the node-environment vitest
// can render it via renderToStaticMarkup — no jsdom, no effects.
export function PairingCodeBox({
  pairingCode,
  onCopy,
}: {
  pairingCode: string;
  onCopy: () => void;
}) {
  return (
    <div className="rounded-lg border bg-muted/50 p-3 flex items-center justify-between gap-2">
      <span data-testid="pairing-code-box" className="font-mono text-lg font-semibold tracking-widest break-all">
        {pairingCode}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="size-7 p-0 flex-shrink-0"
        title="Copy the pairing code"
        onClick={onCopy}
      >
        <Copy className="size-3.5" />
      </Button>
    </div>
  );
}

// ── Agent update hint (ticket 31fd8440, 2026-10-09) ─────────────────────────
//
// The owner re-downloaded the Digby desktop app and STILL had an old Mac agent:
// re-downloading cannot update the agent — the .app bundles its own copy (0.6.3
// in the served 0.1.10 DMG), and the app's one-click "Set up iMessage on this
// Mac" installs THAT bundled copy, clobbering any newer self-managed install.
// The one-liner below pulls the CURRENT release from digby.example.com, installs it at
// ~/Library/Application Support/Digby/imessage-agent (canonical self-managed
// path, .digby-selfupdate marker → it keeps itself current from then on) and
// reloads the same launchd label — no re-download of the .app involved.
//
//   agentVersionOlder(version, latest) → amber hint: which build this Mac has,
//                                        which is current, and the one-liner
//   same/newer version                  → nothing (no noise for up-to-date Macs)
//   platform 'windows'                 → nothing (a Windows agent updates via
//                                        its own installer, never this path)
//   unreadable versions                 → nothing (never claim "outdated")
//
// PURE presentational (MacPermissionsSection idiom) so the node-environment
// vitest can render it with renderToStaticMarkup — no jsdom, no effects.

export function AgentUpdateHint({
  agentVersion,
  latest,
  platform,
  updateCmd,
}: {
  agentVersion?: string | null;
  latest?: string | null;
  platform?: string | null;
  updateCmd: string;
}) {
  if (!agentVersionOlder(agentVersion, latest)) return null;
  if (platform === 'windows') return null;
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 space-y-1" data-testid="agent-update-hint">
      <div className="flex items-center gap-1.5">
        <Download className="size-3 text-amber-600 flex-shrink-0" />
        <p className="text-[11px] font-medium text-amber-600">
          Mac agent update available — v{agentVersion} → v{latest}
        </p>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        This updates the background <span className="font-medium">Digby agent</span> only — not the Digby desktop
        app (they update separately, and the app is not involved in this step). To move this Mac&apos;s agent to the
        current release, paste this in Terminal:
      </p>
      <div className="relative rounded border bg-muted/50 p-2 pr-8">
        <code className="block text-[10px] font-mono break-all leading-relaxed">{updateCmd}</code>
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-1 right-1 size-6 p-0"
          title="Copy the update command"
          onClick={() => {
            navigator.clipboard.writeText(updateCmd);
            toast.success('Copied');
          }}
        >
          <Copy className="size-3" />
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        It installs at <span className="font-mono">~/Library/Application Support/Digby</span> and keeps itself
        updated from then on. Your pairing is kept. Screen Recording / Accessibility / Full Disk Access grants are
        tied to the old helper binary — after the update, re-check them under System Settings → Privacy &amp;
        Security (the pane may still show a stale entry for the previous binary).
      </p>
    </div>
  );
}

// ── macOS permission checklist (ticket 2f646c10, agent ≥ 0.6.0) ─────────────
//
// The Mac helper advertises its TCC state on every poll; this section renders
// it as a live checklist with the exact fix buttons. It is a PURE presentational
// component (FeedbackTab's FeedbackRequestRow idiom) so the node-environment
// vitest can render every state via renderToStaticMarkup — no jsdom.
//
//   !permissions            → legacy agent (pre-0.6.0): the update hint only
//   all granted, no relaunch → single green line (nothing to do)
//   anything missing         → checklist + guidance + Open Settings / Reveal
//   relaunch                 → amber banner above (the post-update ghost-grant
//                              self-heal: bounce the helper, TCC re-evaluates)

/** The TCC permissions the Mac helper needs, in display order. cal is
 *  OPTIONAL in the advert (1ea9a120 — undefined = never read, the row
 *  renders only once the agent has advertised it). */
const PERMISSION_ROWS: ReadonlyArray<{ key: 'ax' | 'sr' | 'fda' | 'cal'; label: string; pane: 'accessibility' | 'screen-recording' | 'full-disk-access' | 'calendars'; hint: string }> = [
  { key: 'ax', label: 'Accessibility', pane: 'accessibility', hint: 'Computer control — moving the mouse and typing' },
  { key: 'sr', label: 'Screen Recording', pane: 'screen-recording', hint: 'Screenshots and screen visibility' },
  { key: 'fda', label: 'Full Disk Access', pane: 'full-disk-access', hint: 'Reading your Messages (chat.db)' },
  { key: 'cal', label: 'Calendars', pane: 'calendars', hint: 'Reading upcoming Calendar events (EventKit)' },
];

export function MacPermissionsSection({
  agent,
  busy,
  error,
  onAction,
}: {
  agent: IMessageAgentInfo;
  busy?: boolean;
  error?: string | null;
  onAction: (action: 'relaunch' | 'open-pane' | 'reveal', pane?: 'accessibility' | 'screen-recording' | 'full-disk-access' | 'calendars') => void;
}) {
  const p = agent.permissions;

  // Legacy agent (pre-0.6.0): no advertisement ever arrived — invite the
  // update instead of guessing at a checklist.
  if (!p) {
    return (
      <div className="text-[11px] text-muted-foreground" data-testid="mac-permissions-legacy">
        Permissions: update the Mac agent to see permission status.
      </div>
    );
  }

  // c44b19e9: an advertised DENIED calendar read (cal === false) is NOT
  // "all granted" — undefined (never read) stays neutral.
  const allGranted = p.ax && p.sr && p.fda && p.cal !== false;
  // cal is OPTIONAL (1ea9a120/c44b19e9): an agent that never read a calendar
  // advertises nothing — the row renders only once the key exists, so
  // "never read" never renders as "missing".
  const rows = PERMISSION_ROWS.filter((row) => row.key !== 'cal' || p.cal !== undefined);
  const firstMissing = rows.find((row) => !p[row.key])?.pane ?? 'accessibility';

  return (
    <div className="space-y-1.5" data-testid="mac-permissions">
      {p.relaunch && (
        <div
          className="rounded-lg border border-warn/60 bg-warn/10 p-2 space-y-1.5"
          data-testid="mac-permissions-relaunch-banner"
        >
          <p className="text-[11px] text-warn-ink leading-snug">
            Accessibility is granted but not active for this helper — a relaunch is needed (this
            can happen after a Digby update).
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px]"
            disabled={busy || !agent.online}
            onClick={() => onAction('relaunch')}
            data-testid="mac-permissions-relaunch"
          >
            Relaunch helper
          </Button>
        </div>
      )}

      {allGranted ? (
        <div className="flex items-center gap-1.5 text-[11px] text-success-accent" data-testid="mac-permissions-ok">
          <span className={cnDot(true)} /> Permissions: all granted ✓
        </div>
      ) : (
        <>
          <div className="space-y-1" data-testid="mac-permissions-checklist">
            {rows.map((row) => {
              const granted = p[row.key];
              return (
                <div key={row.key} className="flex items-center justify-between gap-2" data-testid={`mac-permission-${row.key}`}>
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className={cnDot(granted)} />
                    <span className="text-[11px] truncate" title={row.hint}>{row.label}</span>
                  </span>
                  <Badge
                    variant="outline"
                    className={`h-4 px-1.5 text-[9px] flex-shrink-0 ${granted ? 'text-success-accent' : 'text-muted-foreground'}`}
                  >
                    {granted ? '✓ granted' : '✗ missing'}
                  </Badge>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground leading-snug">
            Grants attach to the helper binary Finder reveals (DigbyHelper in the
            Digby.app install, DigbyAgent on a Terminal one-line install). Since
            helper 0.6.3 the first launch (and every
            update) asks for the core permissions up front — the Accessibility and Screen Recording
            prompts pre-list the helper, so just turn the switch ON; Full Disk Access has
            no prompt, so add it under System Settings → Privacy &amp; Security and toggle it ON.
            If a grant dies after an update (Calendars included), re-make it here and
            QUIT + RELAUNCH the agent — a new grant only applies to a freshly launched process.
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px]"
              disabled={busy || !agent.online}
              onClick={() => onAction('open-pane', firstMissing)}
              data-testid="mac-permissions-open-pane"
            >
              Open System Settings
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px]"
              disabled={busy || !agent.online}
              onClick={() => onAction('reveal')}
              data-testid="mac-permissions-reveal"
            >
              Reveal helper in Finder
            </Button>
          </div>
        </>
      )}

      {error && (
        <p className="text-[10px] text-destructive" data-testid="mac-permissions-error">
          {error}
        </p>
      )}
    </div>
  );
}
