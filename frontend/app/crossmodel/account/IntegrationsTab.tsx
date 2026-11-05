'use client';

import { useState, useEffect } from 'react';
import NextLink from 'next/link';
import { absoluteDate } from '@/lib/relative-time';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  Mail,
  Calendar,
  HardDrive,
  FileText,
  Table,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Unlink,
  Pencil,
  Check,
  X,
  Loader2,
  RefreshCw,
  Plus,
  Briefcase,
  Home,
  Tag,
  Users,
  MessageCircle,
  Send,
  Search,
  Download,
  UserPlus,
  Phone,
  Image,
  Copy,
  GitBranch,
  Code,
  Bug,
  Star,
  FolderGit2,
  ShieldCheck,
  AtSign,
  Hash,
  TrendingUp,
  Heart,
  Laptop,
} from 'lucide-react';
import { googleApi, githubApi, xApi, xeroApi, plaidApi, slackApi, asanaApi, telegramApi, instanceSetupApi, type GoogleAccount, type GitHubAccount, type GitHubStatus, type XAccount, type XStatus, type XeroAccount, type PlaidStatus, type SlackStatus, type AsanaStatus, type TelegramStatus, type InstanceSetup, type InstanceSetupFeature } from '@/lib/api/crossmodel';
// Self-host setup hardening (2026-10-20): which integrations are dark on THIS instance.
import { featureByKey, integrationUnavailable, notConfiguredToast, notSetUpCopy, helpHref, SELF_HOST_HELP } from '@/lib/instance-setup';
import { LoadErrorState } from '@/components/ui/load-error-state';
import PlaidLinkButton from './PlaidLinkButton';
import IMessageCard from './IMessageCard';
import McpServersSection from './McpServersSection';

// ── Google icon (inline SVG — no external image dep) ─────────────────────────
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

// ── Scope display config ──────────────────────────────────────────────────────
const SCOPE_INFO: Record<string, { label: string; icon: React.ElementType; desc: string }> = {
  'gmail.readonly':        { label: 'Read Gmail',      icon: Mail,      desc: 'Read your emails' },
  'gmail.send':            { label: 'Send Gmail',       icon: Mail,      desc: 'Send emails on your behalf' },
  'calendar.readonly':     { label: 'View Calendar',   icon: Calendar,  desc: 'Read calendar events' },
  'calendar.events':       { label: 'Manage Calendar', icon: Calendar,  desc: 'Create and edit events' },
  'drive.readonly':        { label: 'View Drive',       icon: HardDrive, desc: 'Browse your files' },
  'documents.readonly':    { label: 'Read Docs',        icon: FileText,  desc: 'Read Google Docs' },
  'spreadsheets.readonly': { label: 'Read Sheets',      icon: Table,     desc: 'Read Google Sheets' },
  // Editing scopes (2026-09-23): Docs/Sheets/Slides create+edit, Drive uploads, Gmail drafts.
  'auth/documents':        { label: 'Edit Docs',        icon: FileText,  desc: 'Create and edit Google Docs' },
  'auth/spreadsheets':     { label: 'Edit Sheets',      icon: Table,     desc: 'Create and edit Google Sheets' },
  'auth/presentations':    { label: 'Edit Slides',      icon: FileText,  desc: 'Create Google Slides' },
  'drive.file':            { label: 'Upload to Drive',  icon: HardDrive, desc: 'Create files and folders in Drive' },
  'gmail.compose':         { label: 'Gmail Drafts',     icon: Mail,      desc: 'Create draft emails' },
};

function getScopeLabel(scopeUrl: string) {
  // Exact-suffix match first ('…/auth/documents' must not resolve to 'documents.readonly').
  const tail = scopeUrl.replace('https://www.googleapis.com/', '');
  const exact = Object.keys(SCOPE_INFO).find(k => tail === k || tail.endsWith(`/${k}`) || tail === `auth/${k}`);
  if (exact) return SCOPE_INFO[exact];
  const key = Object.keys(SCOPE_INFO).find(k => scopeUrl.includes(k));
  return key ? SCOPE_INFO[key] : null;
}

/** Re-consent for an EXISTING account (2026-09-23 editing scopes): same /auth
 *  flow with the same label — the callback updates the row in place. */
function updateGooglePermissions(label: string) {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
  const token   = localStorage.getItem('accessToken');
  window.location.href = `${apiBase}/crossmodel/google/auth?token=${token}&label=${encodeURIComponent(label)}`;
}

// ── Label presets ─────────────────────────────────────────────────────────────
const LABEL_PRESETS = [
  { value: 'Personal', icon: Home,     emoji: '🏠' },
  { value: 'Work',     icon: Briefcase, emoji: '💼' },
];

// ── Single account card ───────────────────────────────────────────────────────
function AccountCard({
  account,
  onDisconnect,
  onRename,
}: {
  account: GoogleAccount;
  onDisconnect: (label: string) => Promise<void>;
  onRename: (id: string, label: string) => Promise<void>;
}) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.label);
  const [saving, setSaving] = useState(false);

  const saveRename = async () => {
    const label = draft.trim();
    if (!label || label === account.label) {
      setEditing(false);
      setDraft(account.label);
      return;
    }
    setSaving(true);
    try {
      await onRename(account.id, label);
      setEditing(false);
    } catch {
      // Parent already toasted the reason — stay in edit mode so the user can adjust.
    } finally {
      setSaving(false);
    }
  };

  const labelEmoji = LABEL_PRESETS.find(p => p.value === account.label)?.emoji || '🔗';

  return (
    <div className="rounded-xl border p-4 space-y-3 bg-success-faint border-success-border">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-9 rounded-xl bg-white dark:bg-hover border flex items-center justify-center shadow-sm flex-shrink-0">
            <GoogleIcon className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {editing ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename();
                      if (e.key === 'Escape') { setEditing(false); setDraft(account.label); }
                    }}
                    maxLength={40}
                    className="h-6 text-xs w-44 px-2"
                    autoFocus
                    disabled={saving}
                  />
                  <Button variant="ghost" size="sm" className="size-6 p-0" onClick={saveRename} disabled={saving} aria-label="Save label">
                    {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3 text-ok" />}
                  </Button>
                  <Button variant="ghost" size="sm" className="size-6 p-0" onClick={() => { setEditing(false); setDraft(account.label); }} disabled={saving} aria-label="Cancel rename">
                    <X className="size-3 text-muted-foreground" />
                  </Button>
                </div>
              ) : (
                <>
                  <Badge className="text-[10px] h-5 px-2 bg-muted text-foreground border font-normal gap-1">
                    <span>{labelEmoji}</span>
                    {account.label}
                  </Badge>
                  <button
                    onClick={() => { setDraft(account.label); setEditing(true); }}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={`Rename "${account.label}" account`}
                    title="Rename this account"
                  >
                    <Pencil className="size-3" />
                  </button>
                </>
              )}
              <Badge className="text-[10px] h-5 px-1.5 bg-success-muted text-success-strong border-ok/40">
                <CheckCircle2 className="size-2.5 mr-0.5" />
                Connected
              </Badge>
            </div>
            {account.email && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{account.email}</p>
            )}
          </div>
        </div>

        {/* Disconnect */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-destructive hover:text-destructive border-destructive/40 hover:border-destructive flex-shrink-0"
              disabled={disconnecting}
            >
              {disconnecting
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Unlink className="size-3.5 mr-1" />
              }
              Disconnect
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect "{account.label}" Google account?</AlertDialogTitle>
              <AlertDialogDescription>
                Digby will no longer access {account.email || 'this account'}'s Gmail, Calendar,
                or Drive. You can reconnect at any time.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={async () => {
                  setDisconnecting(true);
                  try {
                    await onDisconnect(account.label);
                  } finally {
                    setDisconnecting(false);
                  }
                }}
                className="bg-destructive hover:bg-destructive/90"
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Editing permissions missing (account connected before 2026-09-23): one-click re-consent */}
      {Array.isArray(account.missingWriteScopes) && account.missingWriteScopes.length > 0 && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-warning-accent/40 bg-warning-accent/10 px-2 py-1.5" data-testid="google-update-permissions">
          <span className="text-[11px] text-muted-foreground">
            Digby can read this account but not create or edit Docs, Sheets, Slides or Drive files yet.
          </span>
          <Button size="sm" variant="outline" className="h-7 text-xs flex-shrink-0" onClick={() => updateGooglePermissions(account.label)}>
            Update permissions
          </Button>
        </div>
      )}
      {/* Scopes */}
      {account.scopes && account.scopes.length > 0 && (
        <div className="grid grid-cols-2 gap-1">
          {account.scopes.map((scope) => {
            const info = getScopeLabel(scope);
            if (!info) return null;
            const Icon = info.icon;
            return (
              <div key={scope} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <CheckCircle2 className="size-2.5 text-success-accent flex-shrink-0" />
                <Icon className="size-2.5 flex-shrink-0" />
                <span className="truncate">{info.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Add Account Dialog ────────────────────────────────────────────────────────
function AddAccountDialog({
  open,
  onClose,
  existingLabels,
}: {
  open: boolean;
  onClose: () => void;
  existingLabels: string[];
}) {
  const [selectedLabel, setSelectedLabel] = useState('Personal');
  const [customLabel, setCustomLabel]     = useState('');
  const [connecting, setConnecting]       = useState(false);
  const isCustom = !LABEL_PRESETS.some(p => p.value === selectedLabel);

  const effectiveLabel = isCustom ? (customLabel.trim() || selectedLabel) : selectedLabel;

  const handleConnect = () => {
    const label = effectiveLabel;
    if (!label.trim()) { toast.error('Please enter a label'); return; }
    if (existingLabels.includes(label)) {
      toast.error(`You already have a "${label}" account connected. Choose a different label.`);
      return;
    }
    setConnecting(true);
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    const token   = localStorage.getItem('accessToken');
    window.location.href = `${apiBase}/crossmodel/google/auth?token=${token}&label=${encodeURIComponent(label)}`;
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GoogleIcon className="size-5" />
            Connect Google Account
          </DialogTitle>
          <DialogDescription>
            Choose a label to identify this account (e.g. Personal or Work).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Preset labels */}
          <div className="flex gap-2">
            {LABEL_PRESETS.map((preset) => (
              <button
                key={preset.value}
                onClick={() => { setSelectedLabel(preset.value); setCustomLabel(''); }}
                className={cn(
                  'flex-1 flex items-center justify-center gap-2 h-10 rounded-lg border text-sm font-medium transition-colors',
                  selectedLabel === preset.value && !isCustom
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-muted/40 hover:bg-muted border-border text-foreground'
                )}
              >
                <span>{preset.emoji}</span>
                {preset.value}
              </button>
            ))}
            <button
              onClick={() => setSelectedLabel('custom')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 h-10 rounded-lg border text-sm font-medium transition-colors',
                isCustom
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted/40 hover:bg-muted border-border text-foreground'
              )}
            >
              <Tag className="size-3.5" />
              Custom
            </button>
          </div>

          {/* Custom label input */}
          {isCustom && (
            <Input
              autoFocus
              placeholder="e.g. School, Freelance, Side Project…"
              value={customLabel}
              onChange={e => setCustomLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleConnect(); }}
              className="h-9"
            />
          )}

          <p className="text-[11px] text-muted-foreground">
            You'll be redirected to Google to grant permissions. Gmail, Calendar, Drive,
            Docs, and Sheets access will be requested.
          </p>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button
            className="flex-1 bg-[linear-gradient(to_right,#4285F4,#34A853)] hover:opacity-90 border-0 text-white gap-1.5"
            onClick={handleConnect}
            disabled={connecting || (isCustom && !customLabel.trim())}
          >
            {connecting
              ? <Loader2 className="size-4 animate-spin" />
              : <GoogleIcon className="size-4" />
            }
            Connect
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Xero brand icon ───────────────────────────────────────────────────────────
function XeroIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <circle cx="12" cy="12" r="11" fill="#13B5EA"/>
      <path d="M7 8l5 4-5 4M12 8l5 4-5 4" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ── Single Xero account card (ticket 64a25e8d — mirrors AccountCard for Google) ─
function XeroAccountCard({
  account,
  onDisconnect,
  onRename,
}: {
  account: XeroAccount;
  onDisconnect: (label: string) => Promise<void>;
  onRename: (id: string, label: string) => Promise<void>;
}) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(account.label);
  const [saving, setSaving] = useState(false);

  const saveRename = async () => {
    const label = draft.trim();
    if (!label || label === account.label) {
      setEditing(false);
      setDraft(account.label);
      return;
    }
    setSaving(true);
    try {
      await onRename(account.id, label);
      setEditing(false);
    } catch {
      // Parent already toasted the reason — stay in edit mode so the user can adjust.
    } finally {
      setSaving(false);
    }
  };

  const labelEmoji = LABEL_PRESETS.find(p => p.value === account.label)?.emoji || '🔗';

  return (
    <div className="rounded-xl border p-4 space-y-3 bg-success-faint border-success-border">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-9 rounded-xl bg-white dark:bg-hover border flex items-center justify-center shadow-sm flex-shrink-0">
            <XeroIcon className="size-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {editing ? (
                <div className="flex items-center gap-1">
                  <Input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveRename();
                      if (e.key === 'Escape') { setEditing(false); setDraft(account.label); }
                    }}
                    maxLength={40}
                    className="h-6 text-xs w-44 px-2"
                    autoFocus
                    disabled={saving}
                  />
                  <Button variant="ghost" size="sm" className="size-6 p-0" onClick={saveRename} disabled={saving} aria-label="Save label">
                    {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3 text-ok" />}
                  </Button>
                  <Button variant="ghost" size="sm" className="size-6 p-0" onClick={() => { setEditing(false); setDraft(account.label); }} disabled={saving} aria-label="Cancel rename">
                    <X className="size-3 text-muted-foreground" />
                  </Button>
                </div>
              ) : (
                <>
                  <Badge className="text-[10px] h-5 px-2 bg-muted text-foreground border font-normal gap-1">
                    <span>{labelEmoji}</span>
                    {account.label}
                  </Badge>
                  <button
                    onClick={() => { setDraft(account.label); setEditing(true); }}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    aria-label={`Rename "${account.label}" account`}
                    title="Rename this account"
                  >
                    <Pencil className="size-3" />
                  </button>
                </>
              )}
              <Badge className="text-[10px] h-5 px-1.5 bg-success-muted text-success-strong border-ok/40">
                <CheckCircle2 className="size-2.5 mr-0.5" />
                Connected
              </Badge>
            </div>
            {account.orgName
              ? <p className="text-xs text-muted-foreground mt-0.5 truncate">{account.orgName}</p>
              : <p className="text-xs text-muted-foreground mt-0.5 truncate">Xero account linked (no organisation selected yet)</p>
            }
          </div>
        </div>

        {/* Disconnect */}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs text-destructive hover:text-destructive border-destructive/40 hover:border-destructive flex-shrink-0"
              disabled={disconnecting}
            >
              {disconnecting
                ? <Loader2 className="size-3.5 animate-spin" />
                : <Unlink className="size-3.5 mr-1" />
              }
              Disconnect
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect "{account.label}" Xero account?</AlertDialogTitle>
              <AlertDialogDescription>
                Digby will no longer access {account.orgName || 'this account'}'s contacts,
                invoices, bills, or reports. You can reconnect at any time.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={async () => {
                  setDisconnecting(true);
                  try {
                    await onDisconnect(account.label);
                  } finally {
                    setDisconnecting(false);
                  }
                }}
                className="bg-destructive hover:bg-destructive/90"
              >
                Disconnect
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <p className="text-[10px] text-muted-foreground">
        {account.orgName
          ? 'Contacts, invoices, bills, accounts, P&L, and balance sheet data available.'
          : 'Basic connection established. To access accounting data, enable the Accounting API in the Xero Developer Portal and reconnect.'}
      </p>
    </div>
  );
}

// ── Add Xero Account Dialog (ticket 64a25e8d — mirrors AddAccountDialog) ───────
function XeroAddAccountDialog({
  open,
  onClose,
  existingLabels,
}: {
  open: boolean;
  onClose: () => void;
  existingLabels: string[];
}) {
  const [selectedLabel, setSelectedLabel] = useState('Personal');
  const [customLabel, setCustomLabel]     = useState('');
  const [connecting, setConnecting]       = useState(false);
  const isCustom = !LABEL_PRESETS.some(p => p.value === selectedLabel);

  const effectiveLabel = isCustom ? (customLabel.trim() || selectedLabel) : selectedLabel;

  const handleConnect = () => {
    const label = effectiveLabel;
    if (!label.trim()) { toast.error('Please enter a label'); return; }
    if (existingLabels.includes(label)) {
      toast.error(`You already have a "${label}" account connected. Choose a different label.`);
      return;
    }
    setConnecting(true);
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    const token   = localStorage.getItem('accessToken');
    window.location.href = `${apiBase}/crossmodel/xero/auth?token=${token}&label=${encodeURIComponent(label)}`;
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <XeroIcon className="size-5" />
            Connect Xero Account
          </DialogTitle>
          <DialogDescription>
            Choose a label to identify this account (e.g. Personal or Work).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Preset labels */}
          <div className="flex gap-2">
            {LABEL_PRESETS.map((preset) => (
              <button
                key={preset.value}
                onClick={() => { setSelectedLabel(preset.value); setCustomLabel(''); }}
                className={cn(
                  'flex-1 flex items-center justify-center gap-2 h-10 rounded-lg border text-sm font-medium transition-colors',
                  selectedLabel === preset.value && !isCustom
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-muted/40 hover:bg-muted border-border text-foreground'
                )}
              >
                <span>{preset.emoji}</span>
                {preset.value}
              </button>
            ))}
            <button
              onClick={() => setSelectedLabel('custom')}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 h-10 rounded-lg border text-sm font-medium transition-colors',
                isCustom
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-muted/40 hover:bg-muted border-border text-foreground'
              )}
            >
              <Tag className="size-3.5" />
              Custom
            </button>
          </div>

          {/* Custom label input */}
          {isCustom && (
            <Input
              autoFocus
              placeholder="e.g. Acme Ltd, Side Business…"
              value={customLabel}
              onChange={e => setCustomLabel(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleConnect(); }}
              className="h-9"
            />
          )}

          <p className="text-[11px] text-muted-foreground">
            You'll be redirected to Xero to grant access. Connecting a second
            organisation? Give it its own label so you can tell them apart.
          </p>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button
            className="flex-1 bg-[#13B5EA] hover:bg-[#0fa0d0] border-0 text-white gap-1.5"
            onClick={handleConnect}
            disabled={connecting || (isCustom && !customLabel.trim())}
          >
            {connecting
              ? <Loader2 className="size-4 animate-spin" />
              : <XeroIcon className="size-4" />
            }
            Connect
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Generic account-label dialog (replaces window.prompt for GitHub / X) ─────
function LabelPromptDialog({
  open,
  title,
  description,
  suggestion,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  suggestion: string;
  onSubmit: (label: string) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(suggestion);
  // Re-seed the field each time the dialog opens (suggestion depends on
  // which labels are already taken).
  useEffect(() => { if (open) setLabel(suggestion); }, [open, suggestion]);

  const submit = () => {
    const trimmed = label.trim().slice(0, 40);
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="e.g. Personal, Work, Org…"
          value={label}
          maxLength={40}
          onChange={e => setLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit(); }}
        />
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button className="flex-1" onClick={submit} disabled={!label.trim()}>Connect</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── WhatsApp icon ─────────────────────────────────────────────────────────────
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <rect width="24" height="24" rx="4" fill="#25D366"/>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" fill="white"/>
    </svg>
  );
}

// ── Telegram icon ─────────────────────────────────────────────────────────────
function TelegramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <rect width="24" height="24" rx="4" fill="#0088cc"/>
      <path d="M9.417 15.181l-.397 5.584c.568 0 .814-.244 1.109-.537l2.663-2.545 5.518 4.041c1.012.564 1.725.267 1.998-.931L23.93 4.488c.321-1.496-.541-2.081-1.527-1.714l-21.29 8.151c-1.453.564-1.431 1.374-.247 1.741l5.443 1.693L18.953 6.32c.543-.339 1.038-.152.63.218L9.417 15.18z" fill="white"/>
    </svg>
  );
}



// ── Slack icon ─────────────────────────────────────────────────────────────────
function SlackIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <rect width="24" height="24" rx="4" fill="#fff"/>
      <path d="M9.04 14.4a1.36 1.36 0 1 1-1.36-1.36h1.36V14.4zm.68 0a1.36 1.36 0 0 1 2.72 0v3.4a1.36 1.36 0 0 1-2.72 0v-3.4z" fill="#E01E5A"/>
      <path d="M11.08 8.96a1.36 1.36 0 1 1 1.36-1.36v1.36h-1.36zm0 .69a1.36 1.36 0 0 1 0 2.72h-3.4a1.36 1.36 0 0 1 0-2.72h3.4z" fill="#36C5F0"/>
      <path d="M16.52 11.08a1.36 1.36 0 1 1 1.36 1.36h-1.36v-1.36zm-.68 0a1.36 1.36 0 0 1-2.72 0V7.68a1.36 1.36 0 0 1 2.72 0v3.4z" fill="#2EB67D"/>
      <path d="M14.4 16.52a1.36 1.36 0 1 1-1.36 1.36v-1.36h1.36zm0-.68a1.36 1.36 0 0 1 0-2.72h3.4a1.36 1.36 0 0 1 0 2.72h-3.4z" fill="#ECB22E"/>
    </svg>
  );
}

// ── Asana icon ─────────────────────────────────────────────────────────────────
function AsanaIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <rect width="24" height="24" rx="4" fill="#fff"/>
      <circle cx="12" cy="15.6" r="2.7" fill="#F06A6A"/>
      <circle cx="8.2" cy="9" r="2.7" fill="#F06A6A"/>
      <circle cx="15.8" cy="9" r="2.7" fill="#F06A6A"/>
    </svg>
  );
}

// ── GitHub icon ────────────────────────────────────────────────────────────────
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <rect width="24" height="24" rx="4" fill="#24292f"/>
      <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.161 22 16.416 22 12c0-5.523-4.477-10-10-10z" fill="white"/>
    </svg>
  );
}


// ── X (Twitter) icon ───────────────────────────────────────────────────────────
function XIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none">
      <rect width="24" height="24" rx="4" fill="#000000"/>
      <path d="M13.808 10.469L18.244 5.5h-1.052l-3.856 4.313L10.15 5.5H6l4.653 6.516L6 17.5h1.052l4.068-4.55L14.45 17.5H18.6l-4.792-7.031zm-1.44 1.61l-.471-.65L7.56 6.28h1.616l3.025 4.166.472.65 3.937 5.421h-1.616l-3.025-4.436z" fill="white"/>
    </svg>
  );
}


// ── Main component ────────────────────────────────────────────────────────────

// ── "Not set up on this instance" (self-host setup hardening, 2026-10-20) ─────
// Rendered in place of a Connect button / feature preview when GET /instance/setup
// says the provider's Connect path cannot work here. Admins see the exact
// variables + the callback URL to register; everyone else is pointed at their
// administrator. Never shown while the setup state is unknown.
function NotSetUpNotice({ feature, label, admin }: { feature: InstanceSetupFeature; label: string; admin: boolean }) {
  return (
    <div className="rounded-xl border border-warn/40 bg-warn/6 dark:bg-warn/8 p-4 space-y-2" data-testid={`not-set-up-${feature.key}`}>
      <div className="flex items-center gap-2">
        <AlertCircle className="size-3.5 text-warn-ink flex-shrink-0" />
        <p className="text-xs font-medium text-warn-ink">Not set up on this instance</p>
      </div>
      {admin ? (
        <div className="space-y-1.5">
          <p className="text-[11px] text-warn-ink/90 leading-relaxed">{feature.hint || notSetUpCopy(label)}</p>
          {(feature.missing?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-warn-ink/80">Missing in .env:</span>
              {feature.missing!.map((name) => (
                <code key={name} className="rounded border border-warn/40 bg-warn/8 px-1.5 py-0.5 text-[10.5px] font-mono text-warn-ink">{name}</code>
              ))}
            </div>
          )}
          {feature.redirectUri && (
            <p className="text-[11px] text-warn-ink/90 break-all">Callback URL to register: <code className="font-mono text-[10.5px]">{feature.redirectUri}</code></p>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-warn-ink/90 leading-relaxed">{notSetUpCopy(label)}</p>
      )}
      <NextLink href={helpHref(feature)} className="inline-flex items-center gap-1 text-[11px] text-warn-ink underline underline-offset-2">
        Self-hosting guide <ExternalLink className="size-3" />
      </NextLink>
    </div>
  );
}

/** The one-line instance banner at the top of the tab (self-hosted instances only). */
function InstanceBanner({ setup }: { setup: InstanceSetup }) {
  const integrations = setup.features.filter((f) => f.group === 'integrations');
  const ready = integrations.filter((f) => f.configured).length;
  const host = setup.instance.publicUrl ? setup.instance.publicUrl.replace(/^https?:\/\//, '') : 'this instance';
  return (
    <div className="rounded-lg border border-line bg-hover dark:bg-hover/20 px-3 py-2.5 text-[11px] text-ink dark:text-ink-2" data-testid="instance-banner">
      <strong>Self-hosted instance</strong> at {host} — {ready} of {integrations.length} integrations are set up here.{' '}
      {setup.viewer.admin
        ? <>Configure the rest under <NextLink href="/account?tab=admin" className="underline underline-offset-2">Account → Admin → Setup</NextLink>.</>
        : <>An administrator configures the rest.</>}{' '}
      <NextLink href={SELF_HOST_HELP} className="underline underline-offset-2">Self-hosting guide</NextLink>
    </div>
  );
}

export function IntegrationsTab() {
  const [accounts, setAccounts]   = useState<GoogleAccount[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showAddDialog, setShowAddDialog] = useState(false);
  // Ticket 31fd8440: which Mac agent the CURRENTLY-served Digby.dmg bundles
  // (desktop-latest.json's agentVersion stamp — build-app.sh writes it, same
  // origin as the download button). The download line says so out loud: an
  // owner re-downloaded the app expecting the CURRENT agent and got the 0.6.3
  // copy the DMG still bundles — nothing anywhere said which agent a re-download
  // installs. The service worker bypasses this feed (never cached).
  const [dmgAgentVersion, setDmgAgentVersion] = useState<string | null>(null);

  // Ticket 31fd8440: read the SAME feed the app's own updater reads
  // (desktop-latest.json — never SW-cached) for the bundled-agent stamp, so
  // the download line says WHICH agent a re-download installs. No comparison
  // here — the card below owns "your Mac's agent vX vs latest vY" from the
  // status it already fetches. A fetch failure stays silent: the line simply
  // shows no agent version, never an error (display nicety, not a gate).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/desktop-latest.json');
        if (!res.ok) return;
        const feed = await res.json();
        if (!cancelled && typeof feed?.agentVersion === 'string') {
          setDmgAgentVersion(feed.agentVersion);
        }
      } catch { /* feed unavailable → no agent version shown */ }
    })();
    return () => { cancelled = true; };
  }, []);
  const [xeroAccounts, setXeroAccounts] = useState<XeroAccount[]>([]);
  const [showXeroAddDialog, setShowXeroAddDialog] = useState(false);
  const [plaidStatus, setPlaidStatus] = useState<PlaidStatus | null>(null);
  const [plaidDisconnecting, setPlaidDisconnecting] = useState(false);
  const [slackStatus, setSlackStatus] = useState<SlackStatus | null>(null);
  const [slackConnecting, setSlackConnecting] = useState(false);
  const [slackDisconnecting, setSlackDisconnecting] = useState(false);
  const [asanaStatus, setAsanaStatus] = useState<AsanaStatus | null>(null);
  const [asanaConnecting, setAsanaConnecting] = useState(false);
  const [asanaDisconnecting, setAsanaDisconnecting] = useState(false);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);
  const [telegramConnecting, setTelegramConnecting] = useState(false);
  const [telegramDisconnecting, setTelegramDisconnecting] = useState(false);
  const [githubAccounts, setGithubAccounts] = useState<GitHubAccount[]>([]);
  const [githubStatus, setGithubStatus] = useState<GitHubStatus | null>(null);
  const [githubConnecting, setGithubConnecting] = useState(false);
  const [githubDisconnectingLabel, setGithubDisconnectingLabel] = useState<string | null>(null);
  const [githubShowPat, setGithubShowPat] = useState(false);
  const [githubPat, setGithubPat] = useState('');
  const [githubPatLabel, setGithubPatLabel] = useState('');
  const [githubPatConnecting, setGithubPatConnecting] = useState(false);
  const [xAccounts, setXAccounts] = useState<XAccount[]>([]);
  const [xConnecting, setXConnecting] = useState(false);
  const [xDisconnectingLabel, setXDisconnectingLabel] = useState<string | null>(null);
  // Platform X read-path health (fa956f09): null = no recorded outcome yet
  // (treat as healthy); 'fail' = the x-mcp read service is failing for
  // EVERYONE — badge it instead of showing a plain "connected".
  const [xReadHealth, setXReadHealth] = useState<XStatus['readHealth']>(null);
  // Which multi-account integration is asking for a label ('github' | 'x').
  const [labelPrompt, setLabelPrompt] = useState<'github' | 'x' | null>(null);
  // Integrations whose status fetch FAILED (network/server error) — rendered as
  // a load-error banner, never as "disconnected" (that invites pointless re-auth).
  const [loadFailed, setLoadFailed] = useState<string[]>([]);
  const noteLoadFailure = (name: string) =>
    setLoadFailed(prev => (prev.includes(name) ? prev : [...prev, name]));
  // Self-host setup hardening (2026-10-20): what THIS instance has configured.
  // null until known — a failed read never hides a Connect button (the backend
  // bounces an unconfigured provider with ?x=not_configured anyway).
  const [setup, setSetup] = useState<InstanceSetup | null>(null);
  const gate = (key: string): InstanceSetupFeature | null => (integrationUnavailable(setup, key) ? featureByKey(setup, key) : null);
  // GitHub with no OAuth app but a token-encryption key: Connect works by pasting a
  // personal access token, so the OAuth button is replaced, not the whole card.
  const githubFeature = featureByKey(setup, 'github');
  const githubOAuthOff = !!githubFeature && githubFeature.configured && githubFeature.oauth === false;
  // With no OAuth app the pasted token IS the Connect path — open it by default.
  useEffect(() => {
    if (githubOAuthOff && githubAccounts.length === 0) setGithubShowPat(true);
  }, [githubOAuthOff, githubAccounts.length]);
  // Telegram: the setup feature (token + username + webhook secret, and on a
  // self-host the registered webhook) outranks /telegram/status's token-only
  // `configured`, so a half-configured bot never shows a Connect button.
  const telegramFeature = featureByKey(setup, 'telegram');
  const telegramWebhookPending = !!setup?.instance.selfHosted && !!telegramFeature && telegramFeature.configured && telegramFeature.state === 'partial';

  // Read URL params after redirect (google/xero/slack/asana/github/x = connected | error | not_configured)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const googleParam = params.get('google');
    const xeroParam   = params.get('xero');
    const slackParam  = params.get('slack');
    const asanaParam  = params.get('asana');
    const githubParam     = params.get('github');

    if (googleParam === 'connected') {
      toast.success('Google account connected! ✨');
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (googleParam === 'not_configured') {
      toast.error(notConfiguredToast('Google Workspace', params.get('reason')));
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (googleParam === 'error') {
      toast.error('Failed to connect Google — please try again.');
      window.history.replaceState({}, '', '/account?tab=integrations');
    }
    if (xeroParam === 'connected') {
      toast.success('Xero account connected! 📊');
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (xeroParam === 'auth_required') {
      toast.error('Please log in to connect Xero.');
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (xeroParam === 'not_configured') {
      toast.error(notConfiguredToast('Xero', params.get('reason')));
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (xeroParam === 'error') {
      toast.error('Failed to connect Xero — please try again or contact support.');
      window.history.replaceState({}, '', '/account?tab=integrations');
    }
    if (slackParam === 'connected') {
      toast.success('Slack workspace connected! 💬');
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (slackParam === 'not_configured') {
      toast.error(notConfiguredToast('Slack', params.get('reason')));
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (slackParam === 'auth_required') {
      toast.error('Please log in to connect Slack.');
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (slackParam === 'error') {
      // Ticket 24541fb3: Slack returns its own error code (invalid_scope, access_denied …)
      // — show it instead of a generic retry invitation. The owner reconnected three
      // times against an error the UI flattened to "please try again".
      const reason = params.get('reason');
      const reasonMessage = reason === 'invalid_scope'
        ? 'Slack rejected the permission list (invalid_scope) — the Slack app config must add the requested scopes. Contact support.'
        : reason === 'access_denied'
          ? 'Slack connection was cancelled — the permission prompt was declined.'
          : reason ? `Failed to connect Slack (Slack said: ${reason}) — please try again.` : 'Failed to connect Slack — please try again.';
      toast.error(reasonMessage);
      window.history.replaceState({}, '', '/account?tab=integrations');
    }
    if (asanaParam === 'connected') {
      toast.success('Asana account connected! ✅');
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (asanaParam === 'not_configured') {
      toast.error(notConfiguredToast('Asana', params.get('reason')));
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (asanaParam === 'error') {
      toast.error('Failed to connect Asana — please try again.');
      window.history.replaceState({}, '', '/account?tab=integrations');
    }
    if (githubParam === 'connected') {
      toast.success('GitHub account connected! 🐙');
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (githubParam === 'not_configured') {
      toast.error(notConfiguredToast('GitHub', params.get('reason')));
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (githubParam === 'error') {
      toast.error('Failed to connect GitHub — please try again.');
      window.history.replaceState({}, '', '/account?tab=integrations');
    }
    const xParam = params.get('x');
    if (xParam === 'connected') {
      toast.success('X account connected! 🕊️');
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (xParam === 'not_configured') {
      toast.error(notConfiguredToast('X.com', params.get('reason')));
      window.history.replaceState({}, '', '/account?tab=integrations');
    } else if (xParam === 'error') {
      toast.error('Failed to connect X — please try again.');
      window.history.replaceState({}, '', '/account?tab=integrations');
    }
  }, []);

  // NOTE (honest error states): a FAILED status fetch leaves the last-known
  // state in place and records the failure via noteLoadFailure — it must never
  // be rendered as "disconnected" during an outage.

  // Fetch all connected Google accounts
  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const data = await googleApi.listAccounts();
      setAccounts(data);
    } catch {
      noteLoadFailure('Google');
    } finally {
      setLoading(false);
    }
  };

  // Fetch all connected Xero accounts (ticket 64a25e8d — multi-account list)
  const fetchXeroAccounts = async () => {
    try {
      const data = await xeroApi.listAccounts();
      setXeroAccounts(data);
    } catch {
      noteLoadFailure('Xero');
    }
  };

  // Fetch Plaid status
  const fetchPlaidStatus = async () => {
    try {
      const data = await plaidApi.getStatus();
      setPlaidStatus(data);
    } catch {
      noteLoadFailure('Plaid');
    }
  };

  // Fetch Slack status
  const fetchSlackStatus = async () => {
    try {
      const data = await slackApi.getStatus();
      setSlackStatus(data);
    } catch {
      noteLoadFailure('Slack');
    }
  };

  // Fetch Asana status
  const fetchAsanaStatus = async () => {
    try {
      const data = await asanaApi.getStatus();
      setAsanaStatus(data);
    } catch {
      noteLoadFailure('Asana');
    }
  };

  // Fetch Telegram status
  const fetchTelegramStatus = async () => {
    try {
      const data = await telegramApi.getStatus();
      setTelegramStatus(data);
    } catch {
      noteLoadFailure('Telegram');
    }
  };

  const fetchGitHubAccounts = async () => {
    try {
      const data = await githubApi.listAccounts();
      setGithubAccounts(data);
      setGithubStatus(data.length > 0 ? { connected: true, username: data[0]?.username } : { connected: false });
    } catch {
      noteLoadFailure('GitHub');
    }
  };

  const fetchXAccounts = async () => {
    try {
      setXAccounts(await xApi.listAccounts());
    } catch {
      noteLoadFailure('X');
    }
    // Platform read-path health (fa956f09): "connected" below only reflects the
    // OAuth row — this second cheap call is what lets the UI badge a platform-
    // side X outage instead of implying reads are fine while they return empty.
    try {
      const status = await xApi.getStatus();
      setXReadHealth(status.readHealth ?? null);
    } catch {
      /* status fetch failing already banners via the account call above */
    }
  };

  const fetchEverything = () => {
    setLoadFailed([]);
    fetchAccounts(); fetchXeroAccounts(); fetchPlaidStatus(); fetchSlackStatus();
    fetchAsanaStatus(); fetchTelegramStatus(); fetchGitHubAccounts(); fetchXAccounts();
    instanceSetupApi.get().then(setSetup).catch(() => { /* unknown ⇒ render as today */ });
  };

  useEffect(() => { fetchEverything(); }, []);

  // Telegram links complete in the Telegram app (no OAuth redirect back to us), so
  // re-check the connection whenever the user returns to this tab.
  useEffect(() => {
    const onFocus = () => { fetchTelegramStatus(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Build the OAuth-start URL for the X "Connect" buttons. Token + optional label.
  const buildXAuthUrl = (label: string) => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') ?? '' : '';
    const labelParam = label ? `&label=${encodeURIComponent(label)}` : '';
    return `${apiBase}/crossmodel/x/auth?token=${encodeURIComponent(token)}${labelParam}`;
  };

  const startGithubOAuth = (label: string) => {
    setGithubConnecting(true);
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    const token = localStorage.getItem('accessToken');
    window.location.href = `${apiBase}/crossmodel/github/auth?token=${token}&label=${encodeURIComponent(label)}`;
  };

  // Suggest the first free preset label for the add-account dialog.
  const suggestLabel = (taken: Set<string>) =>
    taken.has('personal') ? (taken.has('work') ? '' : 'Work') : 'Personal';

  const handleLabelSubmit = (label: string) => {
    const kind = labelPrompt;
    if (!kind) return;
    const taken = new Set((kind === 'github' ? githubAccounts : xAccounts).map(a => a.label.toLowerCase()));
    if (taken.has(label.toLowerCase())) {
      toast.error(`You already have a ${kind === 'github' ? 'GitHub connection' : 'X account'} labelled "${label}".`);
      return; // keep the dialog open so the user can pick another label
    }
    setLabelPrompt(null);
    if (kind === 'github') {
      startGithubOAuth(label);
    } else {
      setXConnecting(true);
      window.location.href = buildXAuthUrl(label);
    }
  };

  const handleDisconnect = async (label: string) => {
    try {
      await googleApi.disconnect(label);
      setAccounts(prev => prev.filter(a => a.label !== label));
      toast.success(`"${label}" account disconnected`);
    } catch {
      toast.error('Failed to disconnect — please try again');
    }
  };

  const handleRename = async (id: string, label: string) => {
    try {
      const updated = await googleApi.renameAccount(id, label);
      setAccounts(prev => prev.map(a => (a.id === id ? { ...a, label: updated.label } : a)));
      toast.success(`Account renamed to "${updated.label}"`);
    } catch (err: any) {
      // Surface the server's reason when there is one (400/404/409 from the API).
      toast.error(err?.response?.data?.error || 'Failed to rename — please try again');
      throw err; // lets the card stay in edit mode
    }
  };

  const handleXeroDisconnect = async (label: string) => {
    try {
      await xeroApi.disconnect(label);
      setXeroAccounts(prev => prev.filter(a => a.label !== label));
      toast.success(`"${label}" Xero account disconnected`);
    } catch {
      toast.error('Failed to disconnect — please try again');
    }
  };

  const handleXeroRename = async (id: string, label: string) => {
    try {
      const updated = await xeroApi.renameAccount(id, label);
      setXeroAccounts(prev => prev.map(a => (a.id === id ? { ...a, label: updated.label } : a)));
      toast.success(`Account renamed to "${updated.label}"`);
    } catch (err: any) {
      // Surface the server's reason when there is one (400/404/409 from the API).
      toast.error(err?.response?.data?.error || 'Failed to rename — please try again');
      throw err; // lets the card stay in edit mode
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const hasAccounts = accounts.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold mb-1">Connected Integrations</h2>
          <p className="text-xs text-muted-foreground">
            Connect your Mac, workspace tools, finance and messaging accounts so Digby can read
            them when you ask — and act on your behalf after confirmation.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="size-8 p-0 flex-shrink-0"
          onClick={fetchEverything}
          title="Refresh"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>

      {/* Honest failure banner — an outage must not read as "disconnected". */}
      {loadFailed.length > 0 && (
        <LoadErrorState
          className="py-4 rounded-xl border border-destructive/30 bg-destructive/5"
          message={`Couldn't load the connection status for ${loadFailed.join(', ')} — the states below may be incomplete. No need to reconnect.`}
          onRetry={fetchEverything}
        />
      )}

      {/* Self-host setup hardening (2026-10-20): which integrations this instance has set up. */}
      {setup?.instance.selfHosted && <InstanceBanner setup={setup} />}

      {/* ── Your Mac — the desktop app + the paired Mac agent (iMessage, browser,
          computer use). Leads the list: it is a device the user owns, not a
          SaaS account (settings audit 2026-09-21). ── */}
      <div className="space-y-3" data-your-mac>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Laptop className="size-5 text-brand-accent" />
            <span className="text-sm font-semibold">Your Mac</span>
          </div>
          {setup?.instance.selfHosted ? (
            /* Self-host setup hardening (2026-10-20): the signed desktop app is built for
               digby.ai (its home URL is fixed at build time) — on this instance use the
               browser; the Mac agent below pairs against this instance's own API. */
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground" data-testid="mac-app-selfhost">Desktop app: built for digby.ai — use the browser here</Badge>
          ) : (
            <a href="/Digby.dmg" download className="flex-shrink-0">
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
                <Download className="size-3.5" /> Download the Mac app
              </Button>
            </a>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          The Digby desktop app runs in its own window, stays signed in, and bundles the Mac agent
          below — one click to set it up. macOS 11+ (Apple Silicon &amp; Intel).
          {dmgAgentVersion && (
            <>
              {' '}
              This download bundles <strong>Mac agent v{dmgAgentVersion}</strong> — the card below shows which agent
              your Mac runs and how to update it.
            </>
          )}
        </p>
        <IMessageCard />
      </div>

      {/* ── Google Workspace section ── */}
      <Separator />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GoogleIcon className="size-5" />
            <span className="text-sm font-semibold">Google Workspace</span>
            {hasAccounts && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                {accounts.length} connected
              </Badge>
            )}
          </div>
          {gate('google') ? (
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground">Not set up on this instance</Badge>
          ) : (
            <Button
              size="sm"
              className="h-7 text-xs bg-[linear-gradient(to_right,#4285F4,#34A853)] hover:opacity-90 border-0 text-white gap-1.5"
              onClick={() => setShowAddDialog(true)}
            >
              <Plus className="size-3.5" />
              {hasAccounts ? 'Add Account' : 'Connect Google'}
            </Button>
          )}
        </div>

        {gate('google') && <NotSetUpNotice feature={gate('google')!} label="Google Workspace" admin={!!setup?.viewer.admin} />}

        {/* Connected accounts */}
        {hasAccounts ? (
          <div className="space-y-3">
            {accounts.map(account => (
              <AccountCard
                key={account.id}
                account={account}
                onDisconnect={handleDisconnect}
                onRename={handleRename}
              />
            ))}

            {/* Usage tip */}
            <div className="rounded-lg bg-hover dark:bg-hover/20 border border-line px-3 py-2.5">
              <p className="text-[11px] text-ink dark:text-ink-2 leading-relaxed">
                💡 <strong>Try asking:</strong>{' '}
                &ldquo;What&rsquo;s on my calendar today?&rdquo;{' '}
                &ldquo;Show my recent emails&rdquo;{' '}
                &ldquo;Send an email to…&rdquo;
              </p>
            </div>
          </div>
        ) : (
          /* Not connected — feature preview */
          <div className="rounded-xl border p-5 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {[
                { icon: Mail,      label: 'Gmail',    desc: 'Read inbox' },
                { icon: Calendar,  label: 'Calendar', desc: 'View events' },
                { icon: HardDrive, label: 'Drive',    desc: 'Browse files' },
                { icon: FileText,  label: 'Docs',     desc: 'Read documents' },
                { icon: Table,     label: 'Sheets',   desc: 'Read data' },
                { icon: Mail,      label: 'Send',     desc: 'With confirmation' },
              ].map(({ icon: Icon, label, desc }) => (
                <div
                  key={label}
                  className="flex items-center gap-2 rounded-lg border border-dashed border-muted-foreground/20 px-2.5 py-2"
                >
                  <Icon className="size-3.5 text-muted-foreground/60 flex-shrink-0" />
                  <div>
                    <p className="text-[11px] font-medium">{label}</p>
                    <p className="text-[10px] text-muted-foreground">{desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── GitHub section (multi-account: any number of OAuth + PAT connections) ── */}
      <Separator />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitHubIcon className="size-5" />
            <span className="text-sm font-semibold">GitHub</span>
            {githubAccounts.length > 0 && (
              <Badge className="text-[10px] h-5 px-1.5 bg-success-muted text-success-strong border-ok/40">
                <CheckCircle2 className="size-2.5 mr-0.5" /> {githubAccounts.length} connected
              </Badge>
            )}
          </div>
          {gate('github') ? (
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground">Not set up on this instance</Badge>
          ) : githubOAuthOff ? (
            /* No OAuth app on this instance — the pasted-token path below is the way in. */
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground" data-testid="github-oauth-off">Paste a token below</Badge>
          ) : (
            <Button size="sm" className="h-7 text-xs bg-[#24292f] hover:bg-[#1b1f23] border-0 text-white gap-1.5" disabled={githubConnecting}
              onClick={() => {
                if (githubAccounts.length > 0) { setLabelPrompt('github'); return; }
                startGithubOAuth('Personal');
              }}>
              {githubConnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              {githubAccounts.length > 0 ? 'Add via OAuth' : 'Connect GitHub'}
            </Button>
          )}
        </div>

        {gate('github') && <NotSetUpNotice feature={gate('github')!} label="GitHub" admin={!!setup?.viewer.admin} />}

        {/* Connected accounts (OAuth + PAT, any number) */}
        {githubAccounts.length > 0 && (
          <div className="space-y-2">
            {githubAccounts.map((acct) => {
              const hasRepo = (acct.scopes ?? []).includes('repo');
              return (
                <div key={acct.id} className="rounded-xl border p-3 flex items-center justify-between gap-3 bg-success-faint border-success-border">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-medium">{acct.label}</span>
                      {acct.username && <span className="text-[11px] text-muted-foreground">@{acct.username}</span>}
                      {!hasRepo && <span className="text-[10px] text-warn-ink">⚠ no repo scope</span>}
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      Repos, issues, PRs, code search, file reads{acct.connectedAt ? ` · connected ${absoluteDate(acct.connectedAt)}` : ''}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:text-destructive border-destructive/40"
                    disabled={githubDisconnectingLabel === acct.label}
                    onClick={async () => {
                      setGithubDisconnectingLabel(acct.label);
                      try {
                        await githubApi.disconnect(acct.label);
                        toast.success(`Disconnected "${acct.label}"`);
                        await fetchGitHubAccounts();
                      } catch { toast.error('Failed to disconnect'); }
                      finally { setGithubDisconnectingLabel(null); }
                    }}>
                    {githubDisconnectingLabel === acct.label ? <Loader2 className="size-3.5 animate-spin" /> : <Unlink className="size-3.5 mr-1" />} Disconnect
                  </Button>
                </div>
              );
            })}
            <div className="rounded-lg bg-hover dark:bg-hover/20 border border-line px-3 py-2">
              <p className="text-[11px] text-ink dark:text-ink-2">💡 <strong>Try:</strong> &ldquo;Show my GitHub repos&rdquo; &ldquo;Read canada-quant/&lt;repo&gt; README&rdquo; &ldquo;Search code for…&rdquo; — Digby queries all connected accounts.</p>
            </div>
          </div>
        )}

        {/* Intro shown only when nothing is connected yet */}
        {githubAccounts.length === 0 && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">Connect GitHub to let Digby interact with your repositories, issues, pull requests, code search, and more. Add multiple accounts and connect via the OAuth app and/or Personal Access Tokens — Digby uses all of them.</p>
        )}

        {/* Personal Access Token — add another connection (reliable for private org repos).
            Not offered when this instance cannot store a token (no GITHUB_TOKEN_ENCRYPTION_KEY). */}
        {!gate('github') && (
        <div className="rounded-xl border p-3" data-testid="github-pat-block">
          {!githubShowPat ? (
            <button type="button" onClick={() => setGithubShowPat(true)} className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
              {githubAccounts.length > 0 ? 'Add another connection with a Personal Access Token' : 'Or connect with a Personal Access Token'} — best for private org repos
            </button>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                {githubOAuthOff && <>This instance has no GitHub OAuth app, so a token is the way to connect. </>}
                Paste a GitHub{' '}
                <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer" className="underline">personal access token</a>{' '}
                with the <code className="text-[10px] bg-muted px-1 rounded">repo</code> scope (classic) or repository <strong>Contents: Read</strong> (fine-grained). Reads private organization repos without the org approving the OAuth app.
              </p>
              <div className="flex gap-1.5">
                <input type="text" value={githubPatLabel} onChange={(e) => setGithubPatLabel(e.target.value)} placeholder="Label" autoComplete="off" spellCheck={false} className="w-24 h-7 rounded-md border bg-background px-2 text-xs" />
                <input type="password" value={githubPat} onChange={(e) => setGithubPat(e.target.value)} placeholder="ghp_… or github_pat_…" autoComplete="off" spellCheck={false} className="flex-1 h-7 rounded-md border bg-background px-2 text-xs font-mono" />
                <Button size="sm" className="h-7 text-xs bg-[#24292f] hover:bg-[#1b1f23] border-0 text-white"
                  disabled={githubPatConnecting || githubPat.trim().length < 20}
                  onClick={async () => {
                    const used = new Set(githubAccounts.map((a) => a.label.toLowerCase()));
                    const label = (githubPatLabel.trim() || 'Token').slice(0, 40);
                    if (used.has(label.toLowerCase())) { toast.error(`You already have a connection labelled "${label}".`); return; }
                    setGithubPatConnecting(true);
                    try {
                      await githubApi.connectPat(githubPat.trim(), label);
                      setGithubPat(''); setGithubPatLabel(''); setGithubShowPat(false);
                      toast.success('GitHub connected via token 🐙');
                      await fetchGitHubAccounts();
                    } catch (e: any) {
                      toast.error(e?.response?.data?.error || 'Failed to connect token');
                    } finally { setGithubPatConnecting(false); }
                  }}>
                  {githubPatConnecting ? <Loader2 className="size-3.5 animate-spin" /> : 'Connect'}
                </Button>
              </div>
            </div>
          )}
        </div>
        )}

        {/* Capability grid shown only when nothing is connected yet */}
        {githubAccounts.length === 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {([
              { icon: FolderGit2, label: 'Repositories', desc: 'Search, browse, fork' },
              { icon: GitBranch, label: 'Branches & PRs', desc: 'Create, merge, review' },
              { icon: Bug, label: 'Issues', desc: 'Create, search, manage' },
              { icon: Code, label: 'Code Search', desc: 'Search across repos' },
              { icon: Star, label: 'File Operations', desc: 'Read, create, push' },
              { icon: ShieldCheck, label: 'OAuth or PAT', desc: 'Per-account access' },
            ] as const).map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex items-center gap-2 rounded-lg border border-dashed border-muted-foreground/20 px-2.5 py-2">
                <Icon className="size-3.5 text-muted-foreground/60 flex-shrink-0" />
                <div><p className="text-[11px] font-medium">{label}</p><p className="text-[10px] text-muted-foreground">{desc}</p></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Slack section ── */}
      <Separator />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SlackIcon className="size-5" />
            <span className="text-sm font-semibold">Slack</span>
            {slackStatus?.connected && (
              <Badge className="text-[10px] h-5 px-1.5 bg-success-muted text-success-strong border-ok/40">
                <CheckCircle2 className="size-2.5 mr-0.5" /> Connected
              </Badge>
            )}
          </div>
          {gate('slack') ? (
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground">Not set up on this instance</Badge>
          ) : slackStatus?.connected ? (
            <Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:text-destructive border-destructive/40" disabled={slackDisconnecting}
              onClick={async () => { setSlackDisconnecting(true); try { await slackApi.disconnect(); setSlackStatus({ connected: false }); toast.success('Slack disconnected'); } catch { toast.error('Failed to disconnect'); } finally { setSlackDisconnecting(false); } }}>
              {slackDisconnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Unlink className="size-3.5 mr-1" />} Disconnect
            </Button>
          ) : (
            <Button size="sm" className="h-7 text-xs bg-[#4A154B] hover:bg-[#3a1039] border-0 text-white gap-1.5" disabled={slackConnecting}
              onClick={() => { setSlackConnecting(true); const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api'; const token = localStorage.getItem('accessToken'); const desktop = typeof window !== 'undefined' && (window as any).__digbyDesktop ? '&desktop=1' : ''; window.location.href = `${apiBase}/crossmodel/slack/auth?token=${token}${desktop}`; }}>
              {slackConnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Connect Slack
            </Button>
          )}
        </div>
        {gate('slack') && <NotSetUpNotice feature={gate('slack')!} label="Slack" admin={!!setup?.viewer.admin} />}
        {slackStatus?.connected ? (
          <div className="rounded-xl border p-4 space-y-2 bg-success-faint border-success-border">
            {slackStatus.teamName && <p className="text-xs font-medium">{slackStatus.teamName}</p>}
            {slackStatus.missingScopes && slackStatus.missingScopes.length > 0 && (
              // Ticket 24541fb3: the token predates the im/mpim history scopes —
              // DMs and group DMs are unreadable until the user reconnects (Slack
              // appends the new scopes; existing ones are never removed).
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                  <strong>DM reads unavailable</strong> — this connection is missing {slackStatus.missingScopes.join(', ')}.{' '}
                  Reconnect Slack to grant it (nothing is lost; permissions are only added).
                </p>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground">Channels, recent messages, full-text search, and member directory available.</p>
            <div className="rounded-lg bg-hover dark:bg-hover/20 border border-line px-3 py-2 mt-2">
              <p className="text-[11px] text-ink dark:text-ink-2">💡 <strong>Try:</strong> &ldquo;Catch me up on #general&rdquo; &ldquo;Search Slack for the launch plan&rdquo; &ldquo;Who&apos;s in my workspace?&rdquo;</p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border p-4">
            <p className="text-[11px] text-muted-foreground mb-2">Connect Slack to let Digby read your channels, catch you up on recent messages, search the workspace, and look up teammates.{gate('slack') ? null : <> Digby hosts the integration — just click Connect and approve.</>}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {([
                { icon: Hash, label: 'Channels' },
                { icon: MessageCircle, label: 'Messages' },
                { icon: Search, label: 'Search' },
                { icon: Users, label: 'Members' },
              ] as const).map(({ icon: Icon, label }) => (
                <div key={label} className="flex items-center gap-1.5 rounded-lg border border-dashed border-muted-foreground/20 px-2 py-1.5">
                  <Icon className="size-3 text-muted-foreground/60" /><p className="text-[10px] font-medium">{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Asana section ── */}
      <Separator />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AsanaIcon className="size-5" />
            <span className="text-sm font-semibold">Asana</span>
            {asanaStatus?.connected && (
              <Badge className="text-[10px] h-5 px-1.5 bg-success-muted text-success-strong border-ok/40">
                <CheckCircle2 className="size-2.5 mr-0.5" /> Connected
              </Badge>
            )}
          </div>
          {gate('asana') ? (
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground">Not set up on this instance</Badge>
          ) : asanaStatus?.connected ? (
            <Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:text-destructive border-destructive/40" disabled={asanaDisconnecting}
              onClick={async () => { setAsanaDisconnecting(true); try { await asanaApi.disconnect(); setAsanaStatus({ connected: false }); toast.success('Asana disconnected'); } catch { toast.error('Failed to disconnect'); } finally { setAsanaDisconnecting(false); } }}>
              {asanaDisconnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Unlink className="size-3.5 mr-1" />} Disconnect
            </Button>
          ) : (
            <Button size="sm" className="h-7 text-xs bg-[#F06A6A] hover:bg-[#e15555] border-0 text-white gap-1.5" disabled={asanaConnecting}
              onClick={() => { setAsanaConnecting(true); const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api'; const token = localStorage.getItem('accessToken'); window.location.href = `${apiBase}/crossmodel/asana/auth?token=${token}`; }}>
              {asanaConnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Connect Asana
            </Button>
          )}
        </div>
        {gate('asana') && <NotSetUpNotice feature={gate('asana')!} label="Asana" admin={!!setup?.viewer.admin} />}
        {asanaStatus?.connected ? (
          <div className="rounded-xl border p-4 space-y-2 bg-success-faint border-success-border">
            {asanaStatus.asanaName && <p className="text-xs font-medium">{asanaStatus.asanaName}</p>}
            <p className="text-[10px] text-muted-foreground">Your assigned tasks, projects, workspaces, and task search available.</p>
            <div className="rounded-lg bg-hover dark:bg-hover/20 border border-line px-3 py-2 mt-2">
              <p className="text-[11px] text-ink dark:text-ink-2">💡 <strong>Try:</strong> &ldquo;What are my Asana tasks?&rdquo; &ldquo;Show my Asana projects&rdquo; &ldquo;Search Asana for the Q3 launch&rdquo;</p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border p-4">
            <p className="text-[11px] text-muted-foreground mb-2">Connect Asana to let Digby see your assigned tasks, browse projects, and search work across your workspace.{gate('asana') ? null : <> Digby hosts the integration — just click Connect and approve.</>}</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {([
                { icon: CheckCircle2, label: 'My Tasks' },
                { icon: FolderGit2, label: 'Projects' },
                { icon: Search, label: 'Search' },
                { icon: Briefcase, label: 'Workspaces' },
              ] as const).map(({ icon: Icon, label }) => (
                <div key={label} className="flex items-center gap-1.5 rounded-lg border border-dashed border-muted-foreground/20 px-2 py-1.5">
                  <Icon className="size-3 text-muted-foreground/60" /><p className="text-[10px] font-medium">{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Xero Accounting section ── */}
      <Separator />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <XeroIcon className="size-5" />
            <span className="text-sm font-semibold">Xero Accounting</span>
            {xeroAccounts.length > 0 && (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                {xeroAccounts.length} connected
              </Badge>
            )}
          </div>
          {gate('xero') ? (
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground">Not set up on this instance</Badge>
          ) : (
            <Button
              size="sm"
              className="h-7 text-xs bg-[#13B5EA] hover:bg-[#0fa0d0] border-0 text-white gap-1.5"
              onClick={() => setShowXeroAddDialog(true)}
            >
              <Plus className="size-3.5" />
              {xeroAccounts.length > 0 ? 'Add Account' : 'Connect Xero'}
            </Button>
          )}
        </div>

        {gate('xero') && <NotSetUpNotice feature={gate('xero')!} label="Xero Accounting" admin={!!setup?.viewer.admin} />}

        {/* Connected accounts */}
        {xeroAccounts.length > 0 ? (
          <div className="space-y-3">
            {xeroAccounts.map(account => (
              <XeroAccountCard
                key={account.id}
                account={account}
                onDisconnect={handleXeroDisconnect}
                onRename={handleXeroRename}
              />
            ))}

            {/* Usage tip */}
            <div className="rounded-lg bg-hover dark:bg-hover/20 border border-line px-3 py-2.5">
              <p className="text-[11px] text-ink dark:text-ink-2 leading-relaxed">
                💡 <strong>Try:</strong>{' '}
                &ldquo;Show my Xero invoices&rdquo;{' '}
                &ldquo;Who owes me?&rdquo;{' '}
                &ldquo;Profit and loss?&rdquo;{' '}
                {xeroAccounts.length > 1 && <>With multiple accounts, name the label — e.g. &ldquo;Invoices for {xeroAccounts[0].label}&rdquo;.</>}
              </p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border p-4">
            <p className="text-[11px] text-muted-foreground mb-2">Connect Xero to let Digby read your accounting data — add as many organisations as you like, each with its own label.</p>
            <div className="grid grid-cols-3 gap-1.5">
              {['Contacts', 'Invoices', 'Bills', 'Accounts', 'P&L', 'Balance Sheet'].map(l => (
                <div key={l} className="flex items-center gap-1.5 rounded-lg border border-dashed border-muted-foreground/20 px-2 py-1.5">
                  <FileText className="size-3 text-muted-foreground/60" /><p className="text-[10px] font-medium">{l}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Plaid Banking section ── */}
      <Separator />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 24 24" className="size-5" fill="none">
              <rect width="24" height="24" rx="4" fill="#111"/>
              <rect x="4" y="4" width="4" height="4" rx="1" fill="#fff"/>
              <rect x="10" y="4" width="4" height="4" rx="1" fill="#fff"/>
              <rect x="16" y="4" width="4" height="4" rx="1" fill="#fff"/>
              <rect x="4" y="10" width="4" height="4" rx="1" fill="#fff"/>
              <rect x="10" y="10" width="4" height="4" rx="1" fill="#fff"/>
              <rect x="4" y="16" width="4" height="4" rx="1" fill="#fff"/>
              <rect x="10" y="16" width="4" height="4" rx="1" fill="#fff"/>
            </svg>
            <span className="text-sm font-semibold">Plaid Banking</span>
            {plaidStatus?.connected && (
              <Badge className="text-[10px] h-5 px-1.5 bg-success-muted text-success-strong border-ok/40">
                <CheckCircle2 className="size-2.5 mr-0.5" /> {plaidStatus.institutions.length} connected
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            {gate('plaid')
              ? <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground">Not set up on this instance</Badge>
              : <PlaidLinkButton onConnected={(status) => setPlaidStatus(status)} hasExisting={!!plaidStatus?.connected} />}
            {plaidStatus?.connected && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:text-destructive border-destructive/40" disabled={plaidDisconnecting}>
                    {plaidDisconnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Unlink className="size-3.5 mr-1" />} Disconnect All
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Disconnect all bank accounts?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will remove {plaidStatus.institutions.length > 1 ? `all ${plaidStatus.institutions.length} connected bank accounts` : 'your connected bank account'} from Digby.
                      You can reconnect at any time.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive hover:bg-destructive/90"
                      onClick={async () => { setPlaidDisconnecting(true); try { await plaidApi.disconnect(); setPlaidStatus({ connected: false, institutions: [] }); toast.success('All bank accounts disconnected'); } catch { toast.error('Failed to disconnect'); } finally { setPlaidDisconnecting(false); } }}
                    >
                      Disconnect All
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>
        {gate('plaid') && <NotSetUpNotice feature={gate('plaid')!} label="Plaid Banking" admin={!!setup?.viewer.admin} />}
        {plaidStatus?.connected ? (
          <div className="rounded-xl border p-4 space-y-2 bg-success-faint border-success-border">
            {plaidStatus.institutions.map((inst, i) => (
              <p key={i} className="text-xs font-medium">{inst.name}</p>
            ))}
            <p className="text-[10px] text-muted-foreground">Accounts, balances, transactions, and recurring payments data available.</p>
            <div className="rounded-lg bg-hover dark:bg-hover/20 border border-line px-3 py-2 mt-2">
              <p className="text-[11px] text-ink dark:text-ink-2">💡 <strong>Try:</strong> &ldquo;Show my Plaid balances&rdquo; &ldquo;Recent transactions&rdquo; &ldquo;What subscriptions do I have?&rdquo;</p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border p-4">
            <p className="text-[11px] text-muted-foreground mb-2">Connect your bank via Plaid to let Digby read your financial data.</p>
            <div className="grid grid-cols-3 gap-1.5">
              {['Accounts', 'Balances', 'Transactions', 'Recurring', 'Spending', 'Identity'].map(l => (
                <div key={l} className="flex items-center gap-1.5 rounded-lg border border-dashed border-muted-foreground/20 px-2 py-1.5">
                  <FileText className="size-3 text-muted-foreground/60" /><p className="text-[10px] font-medium">{l}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Telegram section (single shared Digby bot + deep-link connect) ── */}
      <Separator />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TelegramIcon className="size-5" />
            <span className="text-sm font-semibold">Telegram</span>
            {telegramStatus?.connected ? (
              <Badge className="text-[10px] h-5 px-1.5 bg-success-muted text-success-strong border-ok/40">
                <CheckCircle2 className="size-2.5 mr-0.5" /> Connected
              </Badge>
            ) : gate('telegram') ? (
              <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground">Not set up on this instance</Badge>
            ) : telegramStatus && telegramStatus.configured === false ? (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-warn/40 text-warn-ink">{setup?.instance.selfHosted ? 'Not set up on this instance' : 'Coming Soon'}</Badge>
            ) : telegramWebhookPending ? (
              <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-warn/40 text-warn-ink" data-testid="telegram-webhook-pending">Webhook not registered</Badge>
            ) : null}
          </div>
          {telegramStatus?.connected ? (
            <Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:text-destructive border-destructive/40" disabled={telegramDisconnecting}
              onClick={async () => { setTelegramDisconnecting(true); try { await telegramApi.disconnect(); setTelegramStatus({ connected: false, configured: telegramStatus?.configured, botUsername: telegramStatus?.botUsername }); toast.success('Telegram disconnected'); } catch { toast.error('Failed to disconnect'); } finally { setTelegramDisconnecting(false); } }}>
              {telegramDisconnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Unlink className="size-3.5 mr-1" />} Disconnect
            </Button>
          ) : gate('telegram') ? null : telegramStatus?.configured !== false ? (
            <Button size="sm" className="h-7 text-xs bg-[#229ED9] hover:bg-[#1c87ba] border-0 text-white gap-1.5" disabled={telegramConnecting}
              onClick={async () => {
                setTelegramConnecting(true);
                try {
                  const url = await telegramApi.getConnectLink();
                  window.open(url, '_blank', 'noopener');
                  toast.info('Press Start in Telegram to finish connecting, then return here.');
                } catch (e: any) {
                  toast.error(e?.response?.data?.error === 'not_configured' ? 'Telegram isn’t configured yet.' : 'Could not start Telegram connect.');
                } finally { setTelegramConnecting(false); }
              }}>
              {telegramConnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Connect Telegram
            </Button>
          ) : null}
        </div>
        {telegramStatus?.connected ? (
          <div className="rounded-xl border p-4 space-y-2 bg-success-faint border-success-border">
            {telegramStatus.username && <p className="text-xs font-medium">@{telegramStatus.username}</p>}
            <p className="text-[10px] text-muted-foreground">Message the Digby bot in Telegram and it answers with Digby&apos;s multi-model AI — your account memory and integrations apply there too.</p>
            <div className="rounded-lg bg-hover dark:bg-hover/20 border border-line px-3 py-2 mt-2">
              <p className="text-[11px] text-ink dark:text-ink-2">💡 Open Telegram and send the Digby bot any question.</p>
            </div>
          </div>
        ) : gate('telegram') ? (
          <div className="rounded-xl border p-4 space-y-3">
            <NotSetUpNotice feature={gate('telegram')!} label="Telegram" admin={!!setup?.viewer.admin} />
          </div>
        ) : (
          <div className="rounded-xl border p-4 space-y-3">
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {telegramStatus?.configured === false
                ? (setup?.instance.selfHosted
                  ? (setup.viewer.admin
                    ? (telegramFeature?.hint || 'Telegram is not set up on this instance — create a bot with @BotFather and set TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and TELEGRAM_WEBHOOK_SECRET, then register the webhook (Account → Admin → Setup).')
                    : notSetUpCopy('Telegram'))
                  : 'Telegram is coming soon — the Digby bot is being set up.')
                : 'Connect Telegram to chat with Digby right inside the Telegram app — ask anything and get multi-model answers, with your Digby memory and integrations. One tap to connect, then press Start in Telegram.'}
            </p>
            {telegramWebhookPending && (
              <p className="text-[11px] text-warn-ink leading-relaxed" data-testid="telegram-webhook-pending-copy">
                {setup?.viewer.admin
                  ? <>{telegramFeature?.hint || <>The bot is configured, but Telegram has not been told this instance&apos;s webhook yet, so messages will not arrive — register it once with the command under Account → Admin → Setup → Telegram.</>}</>
                  : <>{telegramFeature?.summary || 'Telegram is almost ready on this instance'} An administrator finishes the setup (Account → Admin → Setup).</>}
              </p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {([
                { icon: MessageCircle, label: 'Chat with Digby' },
                { icon: Search, label: 'Multi-model answers' },
                { icon: ShieldCheck, label: 'Your memory & integrations' },
                { icon: Send, label: 'On the go' },
              ] as const).map(({ icon: Icon, label }) => (
                <div key={label} className="flex items-center gap-1.5 rounded-lg border border-dashed border-muted-foreground/20 px-2 py-1.5">
                  <Icon className="size-3 text-muted-foreground/60 flex-shrink-0" /><p className="text-[10px] font-medium">{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── X.com (Twitter) section ── */}
      <Separator />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <XIcon className="size-5" />
            <span className="text-sm font-semibold">X.com</span>
            {xAccounts.length > 0 && (
              <Badge className="text-[10px] h-5 px-1.5 bg-success-muted text-success-strong border-ok/40">
                <CheckCircle2 className="size-2.5 mr-0.5" /> {xAccounts.length} connected
              </Badge>
            )}
            {/* fa956f09: platform read-path health. "Connected" above only reflects
                the OAuth row; this amber badge surfaces a platform-side x-mcp/gateway
                outage where X reads return empty for everyone — previously invisible. */}
            {xReadHealth?.status === 'fail' && (
              <Badge className="text-[10px] h-5 px-1.5 bg-warn/10 text-warn-ink border-warn/40 dark:bg-warn/15">
                <AlertCircle className="size-2.5 mr-0.5" /> Reads failing
              </Badge>
            )}
          </div>
          {gate('x') ? (
            <Badge variant="outline" className="text-[10px] h-5 px-1.5 text-muted-foreground">Not set up on this instance</Badge>
          ) : (
            <Button size="sm" className="h-7 text-xs bg-black hover:bg-black/85 border-0 text-white gap-1.5" disabled={xConnecting}
              onClick={() => {
                if (xAccounts.length > 0) { setLabelPrompt('x'); return; }
                setXConnecting(true);
                window.location.href = buildXAuthUrl('Personal');
              }}>
              {xConnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              {xAccounts.length > 0 ? 'Add another X' : 'Connect X'}
            </Button>
          )}
        </div>
        {gate('x') && <NotSetUpNotice feature={gate('x')!} label="X.com" admin={!!setup?.viewer.admin} />}
        {xAccounts.length > 0 ? (
          <div className="space-y-2">
            {xAccounts.map((acct) => (
              <div key={acct.id}
                className="rounded-xl border p-3 flex items-center justify-between gap-3 bg-success-faint border-success-border">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{acct.label}</span>
                    {acct.screenName && <span className="text-[11px] text-muted-foreground">@{acct.screenName}</span>}
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Connected {absoluteDate(acct.connectedAt)}
                  </p>
                </div>
                <Button variant="outline" size="sm" className="h-7 text-xs text-destructive hover:text-destructive border-destructive/40"
                  disabled={xDisconnectingLabel === acct.label}
                  onClick={async () => {
                    setXDisconnectingLabel(acct.label);
                    try {
                      await xApi.disconnect(acct.label);
                      setXAccounts((prev) => prev.filter((a) => a.id !== acct.id));
                      toast.success(`Disconnected "${acct.label}"`);
                    } catch {
                      toast.error('Failed to disconnect');
                    } finally {
                      setXDisconnectingLabel(null);
                    }
                  }}>
                  {xDisconnectingLabel === acct.label
                    ? <Loader2 className="size-3.5 animate-spin" />
                    : <Unlink className="size-3.5 mr-1" />} Disconnect
                </Button>
              </div>
            ))}
            {/* fa956f09: the recorded reason + recency, so the owner can tell a
                current outage from a stale one at a glance. */}
            {xReadHealth?.status === 'fail' && (
              <p className="text-[10px] text-warn-ink">
                ⚠ X reads (search / trends / profiles) are currently failing platform-side
                {xReadHealth.lastError ? ` — last error: ${xReadHealth.lastError.slice(0, 160)}` : ''}
                {xReadHealth.lastErrorAt ? ` (${absoluteDate(xReadHealth.lastErrorAt)})` : ''}.
                Your connection is fine; no need to reconnect.
              </p>
            )}
            <div className="rounded-lg bg-hover dark:bg-hover/20 border border-line px-3 py-2 mt-2">
              <p className="text-[11px] text-ink dark:text-ink-2">💡 <strong>Try:</strong> &ldquo;Post a tweet from my Work account about…&rdquo; &ldquo;Like @paulg&rsquo;s latest&rdquo; &ldquo;Search X for…&rdquo;</p>
            </div>
          </div>
        ) : (
        <div className="rounded-xl border p-4 space-y-3">
          <p className="text-[11px] text-muted-foreground leading-relaxed">Connect X.com so Digby can read posts/threads/profiles and post / reply / like / retweet / follow on your behalf.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {([
              { icon: Send, label: 'Post Tweets', desc: 'Compose & publish' },
              { icon: Search, label: 'Search X', desc: 'Find tweets & topics' },
              { icon: TrendingUp, label: 'Trending', desc: 'Discover trends' },
              { icon: AtSign, label: 'Mentions', desc: 'Track @mentions' },
              { icon: Heart, label: 'Engagement', desc: 'Likes & retweets' },
              { icon: Hash, label: 'Hashtags', desc: 'Topic discovery' },
            ] as const).map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex items-center gap-2 rounded-lg border border-dashed border-muted-foreground/20 px-2.5 py-2">
                <Icon className="size-3.5 text-muted-foreground/60 flex-shrink-0" />
                <div><p className="text-[11px] font-medium">{label}</p><p className="text-[10px] text-muted-foreground">{desc}</p></div>
              </div>
            ))}
          </div>
        </div>
        )}
      </div>

      {/* ── User-added MCP servers (ticket e294f9a4) — any remote MCP server +
          quick-start templates; hides itself (separator included) when the backend switch is off. ── */}
      <McpServersSection />

      {/* ── WhatsApp section ── */}
      <Separator />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <WhatsAppIcon className="size-5" />
            <span className="text-sm font-semibold">WhatsApp</span>
            <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-warn/40 text-warn-ink">{setup?.instance.selfHosted ? 'Not available on this instance' : 'Coming Soon'}</Badge>
          </div>
        </div>
        <div className="rounded-xl border p-4 space-y-3">
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {setup?.instance.selfHosted
              ? 'WhatsApp is a hosted integration planned for digby.ai; it is not available on a self-hosted instance.'
              : <>Connect WhatsApp to let Digby search messages, read chats, send messages, and manage contacts. Digby hosts the integration — just link your account when it&apos;s ready.</>}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {([
              { icon: Search, label: 'Search Messages', desc: 'Full-text search' },
              { icon: MessageCircle, label: 'Read Chats', desc: 'View conversations' },
              { icon: Send, label: 'Send Messages', desc: 'To people & groups' },
              { icon: Phone, label: 'Search Contacts', desc: 'Find by name/number' },
              { icon: Image, label: 'Send Media', desc: 'Photos, videos, docs' },
              { icon: Download, label: 'Download Media', desc: 'Save attachments' },
            ] as const).map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex items-center gap-2 rounded-lg border border-dashed border-muted-foreground/20 px-2.5 py-2">
                <Icon className="size-3.5 text-muted-foreground/60 flex-shrink-0" />
                <div><p className="text-[11px] font-medium">{label}</p><p className="text-[10px] text-muted-foreground">{desc}</p></div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Privacy notice */}
      <div className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/6 dark:bg-warn/8 px-3 py-2.5">
        <AlertCircle className="size-3.5 text-warn-ink flex-shrink-0 mt-0.5" />
        <p className="text-[11px] text-warn-ink leading-relaxed">
          <strong>Privacy:</strong> Integration data is fetched on-demand when you ask a related
          question. It is used only to answer your question and is never stored or shared.
        </p>
      </div>

      <div className="flex items-center justify-end">
        <a
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Manage Google permissions
          <ExternalLink className="size-3" />
        </a>
      </div>

      {/* Add account dialog */}
      <AddAccountDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        existingLabels={accounts.map(a => a.label)}
      />

      {/* Add Xero account dialog */}
      <XeroAddAccountDialog
        open={showXeroAddDialog}
        onClose={() => setShowXeroAddDialog(false)}
        existingLabels={xeroAccounts.map(a => a.label)}
      />

      {/* Label prompt for adding another GitHub / X account */}
      <LabelPromptDialog
        open={labelPrompt !== null}
        title={labelPrompt === 'x' ? 'Add another X account' : 'Add another GitHub account'}
        description={labelPrompt === 'x'
          ? 'Choose a label for the new X account (e.g. Personal, Work, Brand).'
          : 'Choose a label for the new GitHub account (e.g. Personal, Work, Org).'}
        suggestion={suggestLabel(new Set((labelPrompt === 'x' ? xAccounts : githubAccounts).map(a => a.label.toLowerCase())))}
        onSubmit={handleLabelSubmit}
        onClose={() => setLabelPrompt(null)}
      />
    </div>
  );
}
