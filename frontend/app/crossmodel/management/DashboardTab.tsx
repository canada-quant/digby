'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Gauge,
  MessageSquare,
  Folder,
  Play,
  Clock,
  Inbox,
  Loader2,
  Webhook,
  Activity,
  Ban,
  ListChecks,
  CircleX,
  MessageSquareWarning,
  AlarmClockOff,
  PauseCircle,
  AlertTriangle,
  Hand,
  ChevronDown,
  ChevronUp,
  X,
  GitMerge,
  GitPullRequest,
  Rocket,
  ShieldCheck,
  Ticket,
  ExternalLink,
  Sparkles,
  User as UserIcon,
  Check,
  Circle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  fleetApi,
  type FleetOverview,
  type FleetHookRow,
  type FleetDigest,
  type FleetDigestStatus,
  type FleetDigestStats,
  type FleetDigestAttentionKind,
  type FleetDigestAttentionItem,
  type FleetPulse,
  type FleetLatestSummary,
} from '@/lib/api/fleet';
import { usePolling, isAbortError } from '@/lib/use-polling';
import { projectsApi } from '@/lib/api/crossmodel';
import { isDigestStale } from '@/lib/digest-freshness';
import { fleetApi as platformFleetApi, type FleetGoal, type FleetTodo } from '@/lib/api/platform';
import { parseSupervisorWakeNote, classifyWakeHeadline, cleanWakeLabel } from '@/lib/fleet-summary';
import { ProjectPulse } from '../components/ProjectPulse';
import { assigneeLabel, extractWorkRefs, goalBoardBuckets, todoProgress } from '@/lib/fleet-dashboard';
import { relativeTime } from '@/lib/relative-time';
import { formatInterval } from './utils';

const POLL_MS = 20_000;

function sessionStatusBadge(status: string, running: boolean) {
  if (running || status === 'running')
    return <Badge variant="success" className="text-[10px]">Running</Badge>;
  if (status === 'error')
    return <Badge variant="destructive" className="text-[10px]">Error</Badge>;
  if (status === 'ready')
    return <Badge variant="secondary" className="text-[10px]">Ready</Badge>;
  if (status === 'provisioning')
    return <Badge variant="outline" className="text-[10px]">Provisioning</Badge>;
  return <Badge variant="secondary" className="text-[10px]">{status}</Badge>;
}

function scheduleStatusBadge(lastStatus: string | null) {
  if (!lastStatus) return <Badge variant="secondary" className="text-[10px]">never run</Badge>;
  if (lastStatus.includes('error'))
    return <Badge variant="destructive" className="text-[10px]">{lastStatus}</Badge>;
  if (lastStatus.includes('skipped') || lastStatus.includes('cancelled'))
    return <Badge variant="outline" className="text-[10px]">{lastStatus}</Badge>;
  return <Badge variant="secondary" className="text-[10px]">{lastStatus}</Badge>;
}

/** Count tile. `onClick` (optional) makes the whole tile a button — wired
 *  ONLY where the management page already has a natural target (e.g. the
 *  Projects tile scrolls to the Projects card); tiles with no in-page home
 *  stay static rather than inventing routes. */
function StatCard({ icon: Icon, label, value, onClick }: {
  icon: React.ElementType; label: string; value: number; onClick?: () => void;
}) {
  const inner = (
    <CardContent className="px-4 flex items-center gap-3">
      <Icon className="size-4 text-muted-foreground shrink-0" />
      <div className="min-w-0">
        <div className="text-lg font-semibold leading-tight">{value}</div>
        <div className="text-[11px] text-muted-foreground truncate">{label}</div>
      </div>
    </CardContent>
  );
  if (onClick) {
    return (
      <Card className="py-3 gap-1 transition-colors hover:border-muted-foreground/40">
        <button type="button" onClick={onClick} className="w-full text-left cursor-pointer">
          {inner}
        </button>
      </Card>
    );
  }
  return <Card className="py-3 gap-1">{inner}</Card>;
}

/** Attention items shown per digest before the "+N more" expander. */
const VISIBLE_ATTENTION_ITEMS = 3;

function digestStatusBadge(status: FleetDigestStatus) {
  if (status === 'blocked')
    return <Badge variant="destructive" className="text-[10px]">Blocked</Badge>;
  if (status === 'needs_attention')
    return <Badge variant="warning" className="text-[10px]">Needs attention</Badge>;
  if (status === 'on_track')
    return <Badge variant="success" className="text-[10px]">On track</Badge>;
  if (status === 'idle')
    return <Badge variant="secondary" className="text-[10px]">Idle</Badge>;
  return <Badge variant="secondary" className="text-[10px]">{status}</Badge>;
}

/** Small severity-tinted icon + human label per attention-item kind. */
const ATTENTION_KIND_META: Record<
  FleetDigestAttentionKind,
  { icon: React.ElementType; className: string; label: string }
> = {
  blocked_goal:    { icon: Ban,                   className: 'text-destructive',       label: 'Blocked goal' },
  blocked_todo:    { icon: ListChecks,            className: 'text-destructive',       label: 'Blocked todo' },
  awaiting_input:  { icon: Hand,                  className: 'text-brand-accent',        label: 'Waiting on you' },
  failed_run:      { icon: CircleX,               className: 'text-destructive',       label: 'Failed run' },
  stuck_message:   { icon: MessageSquareWarning,  className: 'text-warn-ink',        label: 'Stuck message' },
  schedule_error:  { icon: AlarmClockOff,         className: 'text-warn-ink',        label: 'Schedule error' },
  session_error:   { icon: AlertTriangle,         className: 'text-warn-ink',        label: 'Session error' },
  stalled_session: { icon: PauseCircle,           className: 'text-muted-foreground',  label: 'Stalled session' },
};

/**
 * One compact muted stats line per bucket — interesting numbers only, zeroes
 * skipped. e.g. "3 chats · 41 msgs · 2 runs ✓ 1 ✗ · 5/9 todos · 1 queued".
 */
function digestStatsLine(stats: FleetDigestStats): string | null {
  const parts: string[] = [];
  if (stats.chatCount > 0) {
    parts.push(
      stats.activeChats > 0 && stats.activeChats < stats.chatCount
        ? `${stats.activeChats}/${stats.chatCount} chats active`
        : `${stats.chatCount} chat${stats.chatCount === 1 ? '' : 's'}`,
    );
  }
  if (stats.messages.total > 0) parts.push(`${stats.messages.total} msgs`);
  const runBits: string[] = [];
  if (stats.runs.completed > 0) runBits.push(`${stats.runs.completed} ✓`);
  if (stats.runs.failed > 0) runBits.push(`${stats.runs.failed} ✗`);
  if (stats.runs.active > 0) runBits.push(`${stats.runs.active} active`);
  if (runBits.length > 0) parts.push(`${runBits.join(' ')} runs`);
  if (stats.todos.total > 0) {
    parts.push(
      `${stats.todos.done}/${stats.todos.total} todos` +
        (stats.todos.blocked > 0 ? ` (${stats.todos.blocked} blocked)` : ''),
    );
  }
  if (stats.goals.total > 0) {
    parts.push(
      `${stats.goals.done}/${stats.goals.total} goals` +
        (stats.goals.blocked > 0 ? ` (${stats.goals.blocked} blocked)` : ''),
    );
  }
  if (stats.schedules.firedInWindow > 0) parts.push(`${stats.schedules.firedInWindow} schedule fires`);
  if (stats.schedules.errored > 0) parts.push(`${stats.schedules.errored} schedule errors`);
  if (stats.queuedMessages > 0) parts.push(`${stats.queuedMessages} queued`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** One per-project digest bucket: pill + name + summary + stats + attention items. */
function DigestBucket({ digest, ackedKeys, showAcked, onSilence, onUnack, onOpenProject, onOpenChat }: {
  digest: FleetDigest;
  /** Keys with a live silence (server truth + optimistic). Source of truth for acked-ness. */
  ackedKeys: ReadonlySet<string>;
  showAcked: boolean;
  onSilence: (item: FleetDigestAttentionItem, snoozeHours?: number) => void;
  onUnack: (item: FleetDigestAttentionItem) => void;
  onOpenProject: (projectId: string) => void;
  onOpenChat: (chatId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // f3256715: staleness = pipeline liveness (updatedAt — the hourly sweep
  // touches the row even when the content is unchanged), NOT content age
  // (generatedAt — frozen by design while a quiet bucket's signature holds).
  const stale = isDigestStale(digest);
  // `?? []`: an old backend (deploy skew) may omit the field entirely.
  const all = digest.attentionItems ?? [];
  const isAcked = (item: FleetDigestAttentionItem) => (item.key ? ackedKeys.has(item.key) : !!item.acknowledged);
  // Acked items hide by default; the toggle re-shows them (muted, with Un-ack).
  const items = showAcked ? all : all.filter((item) => !isAcked(item));
  const visible = expanded ? items : items.slice(0, VISIBLE_ATTENTION_ITEMS);
  const hiddenCount = items.length - visible.length;
  // `?.messages`: an old/partial backend row (deploy skew) may have `{}` stats.
  const statsLine = digest.stats?.messages ? digestStatsLine(digest.stats) : null;
  const projectId = digest.projectId;

  return (
    <div className="rounded-md border border-border px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        {digestStatusBadge(digest.status)}
        {projectId ? (
          <button
            onClick={() => onOpenProject(projectId)}
            className="text-xs font-medium truncate hover:underline cursor-pointer"
          >
            {digest.projectName}
          </button>
        ) : (
          <span className="text-xs font-medium text-muted-foreground truncate">{digest.projectName}</span>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground shrink-0">
          updated {relativeTime(digest.generatedAt)}
          {stale && ' · stale'}
        </span>
      </div>
      {stale && (
        <p className="text-[11px] text-warn-ink">
          This digest has not refreshed recently — the hourly digest pipeline may be behind.
        </p>
      )}
      <p className="text-xs text-muted-foreground">{digest.summary}</p>
      {statsLine && <p className="text-[11px] text-muted-foreground">{statsLine}</p>}
      {items.length > 0 && (
        <div className="space-y-1 border-t border-border/60 pt-1.5">
          {visible.map((item, i) => {
            const meta = ATTENTION_KIND_META[item.kind];
            const ItemIcon = meta?.icon ?? AlertTriangle;
            const chatId = item.chatId;
            const acked = isAcked(item);
            const body = (
              <>
                <ItemIcon className={`size-3 shrink-0 ${meta?.className ?? 'text-muted-foreground'}`} />
                <span className="shrink-0 text-muted-foreground">{meta?.label ?? item.kind}</span>
                <span className="font-medium truncate">{item.title}</span>
                {item.detail && (
                  <span className="text-muted-foreground truncate hidden sm:inline">— {item.detail}</span>
                )}
              </>
            );
            return (
              <div
                key={item.key ?? `${item.kind}-${chatId ?? ''}-${i}`}
                className={`flex items-center gap-1.5 text-[11px] ${acked ? 'opacity-60' : ''}`}
              >
                {chatId ? (
                  <button
                    onClick={() => onOpenChat(chatId)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:underline cursor-pointer"
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">{body}</div>
                )}
                {acked ? (
                  <>
                    <span className="shrink-0 text-muted-foreground">
                      · {item.snoozeUntil ? `wakes ${relativeTime(item.snoozeUntil)}` : 'acked'}
                    </span>
                    {/* Never `disabled` (repo learning: Chromium swallows the
                        click AND the tooltip) — these micro-actions always fire. */}
                    <button
                      type="button"
                      onClick={() => onUnack(item)}
                      title="Lift the silence — the item is live again"
                      className="shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      Un-ack
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onSilence(item)}
                      title="Acknowledge — hide until the underlying condition clears"
                      className="shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      Ack
                    </button>
                    <button
                      type="button"
                      onClick={() => onSilence(item, 24)}
                      title="Snooze — hide for 24 hours, then resurface if still present"
                      className="shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
                    >
                      Snooze 24h
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <button
              onClick={() => setExpanded(true)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <ChevronDown className="size-3" />
              +{hiddenCount} more
            </button>
          )}
          {expanded && items.length > VISIBLE_ATTENTION_ITEMS && (
            <button
              onClick={() => setExpanded(false)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
            >
              <ChevronUp className="size-3" />
              Show less
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Hint-only wiring warnings, derived client-side from the hooks the overview
 * endpoint already returns (never auto-disables anything):
 *  - possible loop: two enabled hooks with overlapping event types where each
 *    listens to the other's target, so runs can ping-pong. A wildcard hook
 *    (null sourceChatId) listens to EVERY chat, so wildcard-involved pairs
 *    count too — e.g. the common wildcard→supervisor watcher + a
 *    supervisor→worker completion hook. Same-target pairs are skipped (the
 *    backend suppresses self-wakes, so they cannot ping-pong each other);
 *  - duplicate watcher: multiple enabled wildcard hooks wake the SAME chat for
 *    overlapping event types (e.g. a legacy + current supervisor watcher).
 *    Distinct-target wildcards are healthy, not dupes.
 */
function hookHints(hooks: FleetHookRow[]): Map<string, string[]> {
  const hints = new Map<string, string[]>();
  const add = (id: string, reason: string) => {
    const list = hints.get(id) ?? [];
    list.push(reason);
    hints.set(id, list);
  };
  const overlap = (a: string[], b: string[]) => a.filter((et) => b.includes(et));
  const active = hooks.filter((h) => h.enabled);
  // Wildcards fire on every owned chat's events (backend queries
  // sourceChatId OR null), so they listen to any target.
  const listensTo = (h: FleetHookRow, chatId: string) => !h.sourceChatId || h.sourceChatId === chatId;
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      const shared = overlap(a.eventTypes, b.eventTypes);
      if (shared.length === 0) continue;
      if (a.targetChatId === b.targetChatId) {
        if (!a.sourceChatId && !b.sourceChatId) {
          add(a.id, `Duplicate watcher — another wildcard hook also wakes "${b.targetTitle ?? 'this chat'}" for: ${shared.join(', ')}. One may be legacy.`);
          add(b.id, `Duplicate watcher — another wildcard hook also wakes "${a.targetTitle ?? 'this chat'}" for: ${shared.join(', ')}. One may be legacy.`);
        }
        continue;
      }
      if (listensTo(a, b.targetChatId) && listensTo(b, a.targetChatId)) {
        add(a.id, `Possible loop with the hook waking "${b.targetTitle ?? 'another chat'}" — each can wake the other's target on: ${shared.join(', ')}. Runs can ping-pong; consider disabling one.`);
        add(b.id, `Possible loop with the hook waking "${a.targetTitle ?? 'another chat'}" — each can wake the other's target on: ${shared.join(', ')}. Runs can ping-pong; consider disabling one.`);
      }
    }
  }
  return hints;
}


/** Deploy state → badge. */
function deployBadge(d: NonNullable<NonNullable<FleetPulse['shipping']>['latestDeploy']>) {
  if (d.status !== 'completed')
    return <Badge variant="outline" className="text-[10px]">deploying…</Badge>;
  if (d.conclusion === 'success')
    return <Badge variant="success" className="text-[10px]">deployed</Badge>;
  if (d.conclusion === 'cancelled')
    return <Badge variant="secondary" className="text-[10px]">superseded</Badge>;
  return <Badge variant="destructive" className="text-[10px]">{d.conclusion ?? 'failed'}</Badge>;
}

function prStateBadge(state: FleetPulse['shipping'] extends null ? never : 'merged' | 'open' | 'closed') {
  if (state === 'merged') return <Badge variant="success" className="text-[10px]">merged</Badge>;
  if (state === 'open') return <Badge variant="outline" className="text-[10px]">open</Badge>;
  return <Badge variant="secondary" className="text-[10px]">closed</Badge>;
}

/** One tile in the pulse strip: number + ONE short label line. `sub` WRAPS
 *  (break-words) instead of truncating — a mid-parenthesis "receipts 24h:
 *  3794 (100 failed…" cut is worse than a second line; anything longer than
 *  a short subline belongs in `title` (the hover tooltip). */
function PulseTile({ icon: Icon, label, value, sub, tone, onClick, href, title }: {
  icon: React.ElementType; label: string; value: React.ReactNode; sub?: React.ReactNode;
  tone?: 'ok' | 'warn' | 'bad'; onClick?: () => void; href?: string;
  /** Hover tooltip carrying the long-form detail the tile itself elides. */
  title?: string;
}) {
  const toneCls = tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-warn-ink' : tone === 'ok' ? 'text-success' : '';
  const inner = (
    <div className="flex items-start gap-2.5 min-w-0">
      <Icon className={`size-4 mt-0.5 shrink-0 ${toneCls || 'text-muted-foreground'}`} />
      <div className="min-w-0">
        <div className={`text-base font-semibold leading-tight truncate ${toneCls}`}>{value}</div>
        <div className="text-[11px] text-muted-foreground truncate">{label}</div>
        {sub && <div className="text-[10px] text-muted-foreground/80 break-words">{sub}</div>}
      </div>
    </div>
  );
  const cls = 'rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-left transition-colors' +
    (onClick || href ? ' hover:border-muted-foreground/40 cursor-pointer' : '');
  if (href) return <a className={cls} href={href} target="_blank" rel="noreferrer" title={title}>{inner}</a>;
  if (onClick) return <button type="button" className={cls} onClick={onClick} title={title}>{inner}</button>;
  return <div className={cls} title={title}>{inner}</div>;
}

/**
 * FleetSummaryCard (Issue 7) — the supervisor's latest wake note, parsed
 * server-side out of the DURABLE supervisor transcript by
 * GET /crossmodel/fleet/supervisor/latest-summary — the single source the
 * Supervisor Chat tab also renders, so the dashboard and the chat can never
 * drift (no second summarizer). Collapsed by default: the note's headline
 * first line + up to 4 status chips (parseSupervisorWakeNote, mirroring the
 * chat accordion's label); tapping unfolds the note body inline; "Open wake"
 * hands the note's message id to the management page, which switches to the
 * Supervisor Chat tab with that wake's accordion expanded and scrolled into
 * view. Indigo (info) accent so it never reads as the violet Needs-owner
 * inbox. Renders only when a machine wake note exists.
 *
 * BRIEFING MODE (owner 2026-09-04): when the backend serves an owner briefing
 * (note.kind === 'briefing' — the plain-English layer the supervisor chat
 * also shows as a regular bubble), the card renders it as a friendly readable
 * paragraph: line-clamped ~3 lines collapsed, tap to expand inline, NO status
 * chips, NO wake-tone tinting, footer "your fleet briefing", and the action
 * is "Open chat" (onGoSupervisor — a briefing has no accordion to focus).
 * The technical parse below stays the fallback when no briefing exists.
 */
function FleetSummaryCard({ summary, onOpenWake, onGoSupervisor }: {
  summary: FleetLatestSummary;
  onOpenWake?: (messageId: string) => void;
  onGoSupervisor?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const note = summary.note;
  if (!note) return null;
  if (note.kind === 'briefing') {
    /* Owner briefing mode — friendly paragraph, no chips, no wake chrome. */
    return (
      <Card className="py-4 border-line-2/40 bg-send/5">
        <CardHeader className="px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Sparkles className="size-4 text-ink-2" />
            Fleet summary
            <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{relativeTime(note.createdAt)}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 space-y-2">
          <button type="button" onClick={() => setExpanded((v) => !v)} className="w-full text-left">
            <p className={expanded
              ? 'text-sm leading-6 whitespace-pre-wrap break-words'
              : 'text-sm leading-6 break-words line-clamp-3'}>
              {note.content.trim()}
            </p>
          </button>
          <div className="flex items-center gap-3 text-[11px]">
            {onGoSupervisor && (
              <button type="button" onClick={onGoSupervisor}
                className="inline-flex items-center gap-1 text-ink-2 hover:underline">
                Open chat <ExternalLink className="size-3" />
              </button>
            )}
            <span className="text-muted-foreground ml-auto">your fleet briefing</span>
          </div>
        </CardContent>
      </Card>
    );
  }
  const { headline, chips, body } = parseSupervisorWakeNote(note.content);
  // SHARED classification (lib/fleet-summary) — the same function tints the
  // machine-turn accordion rows, so the card and the chat can never drift
  // (this replaced the card's local `failed` regex, owner polish 2026-09-03).
  const tone = classifyWakeHeadline(headline);
  const toneCls = tone === 'attention' ? 'text-destructive' : tone === 'quiet' ? 'text-muted-foreground' : '';
  return (
    <Card className="py-4 border-line-2/40 bg-send/5">
      <CardHeader className="px-4">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="size-4 text-ink-2" />
          Fleet summary
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{relativeTime(note.createdAt)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 space-y-2">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="w-full text-left">
          <span className="flex items-start gap-1.5">
            {expanded
              ? <ChevronUp className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              : <ChevronDown className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />}
            <span className={expanded
              ? 'text-xs leading-5 whitespace-pre-wrap break-words'
              : `text-xs font-medium truncate ${toneCls}`}>
              {/* Collapsed = the cleaned LABEL (markdown tokens stripped,
                  embedded timestamp de-duped against the card's own time);
                  expanded = the note text as parsed, untouched. */}
              {expanded ? (body ? `${headline}\n${body}` : headline) : cleanWakeLabel(headline)}
            </span>
          </span>
        </button>
        {!expanded && chips.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {chips.map((c, i) => (
              <Badge key={i} variant="outline" className="text-[10px] font-normal max-w-full truncate">{c}</Badge>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 text-[11px]">
          {onOpenWake && (
            <button type="button" onClick={() => onOpenWake(note.id)}
              className="inline-flex items-center gap-1 text-ink-2 hover:underline">
              Open wake <ExternalLink className="size-3" />
            </button>
          )}
          <span className="text-muted-foreground ml-auto">from the supervisor transcript</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function DashboardTab({ onGoSupervisor, onOpenWake }: { onGoSupervisor: () => void; onOpenWake?: (messageId: string) => void }) {
  const router = useRouter();
  const [overview, setOverview] = useState<FleetOverview | null>(null);
  // Pulse: the hero digest (PRs/deploy/queue/guard). Section-scoped failure —
  // a pulse outage must never take down the rest of the dashboard.
  const [pulse, setPulse] = useState<FleetPulse | null>(null);
  // Fleet summary (Issue 7): the supervisor's latest wake note, parsed
  // server-side out of the DURABLE supervisor transcript by
  // GET .../fleet/supervisor/latest-summary — the single source the
  // Supervisor Chat tab also reads, so the two never drift.
  const [fleetSummary, setFleetSummary] = useState<FleetLatestSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Hourly per-project digests — fetched on the same poll as the overview; a
  // section-scoped error keeps a digest outage out of the tab-level error.
  const [digests, setDigests] = useState<FleetDigest[] | null>(null);
  const [digestsError, setDigestsError] = useState<string | null>(null);
  // Digest-item silences (alertmanager-style): ackedKeys is the source of truth
  // for acked-ness — derived from each showAcked fetch, plus optimistic entries
  // (held ~1 poll cycle via pendingSilences so an ack POST racing the next poll
  // doesn't briefly resurrect the item).
  const [showAcked, setShowAcked] = useState(false);
  const [ackedKeys, setAckedKeys] = useState<Set<string>>(new Set());
  const pendingSilences = useRef(new Map<string, number>()); // key → hold-until ms
  // Schedules hygiene: dead (disabled) rows collapse out of the way; the X on
  // a live row cancels it (audited backend endpoint) after a confirm dialog.
  const [showInactiveSchedules, setShowInactiveSchedules] = useState(false);
  const [cancellingScheduleId, setCancellingScheduleId] = useState<string | null>(null);
  const [confirmSchedule, setConfirmSchedule] = useState<{ id: string; snippet: string } | null>(null);
  // Goals board: live goals (active+blocked, two small server-filtered lists)
  // poll with the overview; finished goals load lazily behind the "Show
  // finished" toggle. Per-section errors mirror the digests card — a goals
  // outage must never take down the tab.
  const [goals, setGoals] = useState<FleetGoal[] | null>(null);
  const [goalsError, setGoalsError] = useState<string | null>(null);
  const [chatTitles, setChatTitles] = useState<Map<string, string>>(new Map());
  const [showFinishedGoals, setShowFinishedGoals] = useState(false);
  const [finishedGoals, setFinishedGoals] = useState<FleetGoal[] | null>(null);
  const [finishedGoalsError, setFinishedGoalsError] = useState<string | null>(null);
  const finishedGoalsRequested = useRef(false);
  // Goal expansion lazy-fetches that goal's FULL todos — the goals list
  // payload embeds only id/title/status summaries, so assignee + blockedReason
  // come from listTodos. Cache + failure flags keyed by goalId; the in-flight
  // set dedupes a fast collapse/re-expand.
  const [expandedGoals, setExpandedGoals] = useState<Set<string>>(new Set());
  const [goalTodos, setGoalTodos] = useState<Record<string, FleetTodo[]>>({});
  const [goalTodosFailed, setGoalTodosFailed] = useState<Set<string>>(new Set());
  const goalTodosInflight = useRef(new Set<string>());
  // Nudge-a-lane dialog (POSTs a user message into the lane's queue).
  const [nudgeTarget, setNudgeTarget] = useState<{ chatId: string; title: string } | null>(null);
  const [nudgeContent, setNudgeContent] = useState('');
  const [nudgeSending, setNudgeSending] = useState(false);
  const [nudgeError, setNudgeError] = useState<string | null>(null);

  const refresh = useCallback((signal?: AbortSignal) => {
    fleetApi.getOverview({ signal })
      .then((data) => { setOverview(data); setError(null); })
      .catch((err) => { if (!isAbortError(err)) setError('Could not load fleet status.'); });
    // showAcked=1 always: acked items ride along flagged, so the "show
    // acknowledged" toggle never needs a refetch and optimistic silences
    // reconcile against server truth on the next poll.
    fleetApi.getPulse({ signal })
      .then(setPulse)
      .catch(() => { /* keep the last pulse — the strip shows its own generatedAt */ });
    fleetApi.getLatestSupervisorSummary({ signal })
      .then(setFleetSummary)
      .catch(() => { /* keep the last note — the card shows its own timestamp */ });
    fleetApi.getDigests({ showAcked: true, signal })
      .then((data) => {
        setDigests(data.digests);
        setDigestsError(null);
        const next = new Set<string>();
        for (const d of data.digests) {
          for (const item of d.attentionItems ?? []) {
            if (item.key && item.acknowledged) next.add(item.key);
          }
        }
        const now = Date.now();
        for (const [key, until] of pendingSilences.current) {
          if (until <= now) pendingSilences.current.delete(key);
          else next.add(key);
        }
        setAckedKeys(next);
      })
      .catch((err) => { if (!isAbortError(err)) setDigestsError('Could not load project digests.'); });
    // Goals board: two small server-filtered lists (blocked+active); the chat
    // list feeds the todo assignee id→title map — a chats failure only
    // degrades assignee labels to the "chat <prefix>" fallback.
    Promise.all([
      platformFleetApi.listGoals(undefined, { status: 'active', signal }),
      platformFleetApi.listGoals(undefined, { status: 'blocked', signal }),
    ])
      .then(([active, blocked]) => { setGoals([...active, ...blocked]); setGoalsError(null); })
      .catch((err) => { if (!isAbortError(err)) setGoalsError('Could not load goals.'); });
    platformFleetApi.listChats({ signal })
      .then((rows) => setChatTitles(new Map(rows.map((c) => [c.id, c.title]))))
      .catch(() => { /* keep the last map — labels fall back to chat <prefix> */ });
  }, []);

  // usePolling (P5): abortable ticks (each 20s tick cancels the previous
  // in-flight batch so a slow response can never overwrite newer data),
  // hidden-tab pause + visible catch-up, focus catch-up.
  usePolling((signal) => refresh(signal), { intervalMs: POLL_MS, refreshOnFocus: true });

  /** Runs after the AlertDialog confirm: audited backend cancel → refresh. */
  const cancelSchedule = async (id: string) => {
    setCancellingScheduleId(id);
    try {
      await fleetApi.cancelSchedule(id);
      toast.success('Schedule cancelled.');
      refresh();
    } catch {
      toast.error('Could not cancel the schedule.');
    } finally {
      setCancellingScheduleId(null);
    }
  };

  /**
   * Expand/collapse one goal's todos. The first expand lazy-fetches the goal's
   * FULL todo rows (assigneeChatId/blockedReason are not in the goals list
   * payload); a failed fetch is retried by collapsing + re-expanding.
   */
  const toggleGoal = (goalId: string) => {
    setExpandedGoals((prev) => {
      const next = new Set(prev);
      if (next.has(goalId)) next.delete(goalId);
      else next.add(goalId);
      return next;
    });
    if (goalTodos[goalId] !== undefined || goalTodosInflight.current.has(goalId)) return;
    goalTodosInflight.current.add(goalId);
    platformFleetApi.listTodos({ goalId })
      .then((todos) => {
        setGoalTodos((prev) => ({ ...prev, [goalId]: todos }));
        setGoalTodosFailed((prev) => { const next = new Set(prev); next.delete(goalId); return next; });
      })
      .catch(() => setGoalTodosFailed((prev) => new Set(prev).add(goalId)))
      .finally(() => goalTodosInflight.current.delete(goalId));
  };

  /** "Show finished" — lazily loads done+archived goals ONCE on first expand. */
  const toggleFinishedGoals = () => {
    const next = !showFinishedGoals;
    setShowFinishedGoals(next);
    if (!next || finishedGoalsRequested.current) return;
    finishedGoalsRequested.current = true;
    Promise.all([
      platformFleetApi.listGoals(undefined, { status: 'done' }),
      platformFleetApi.listGoals(undefined, { status: 'archived' }),
    ])
      .then(([done, archived]) => { setFinishedGoals([...done, ...archived]); setFinishedGoalsError(null); })
      .catch(() => setFinishedGoalsError('Could not load finished goals.'));
  };

  /** Open the nudge dialog for one lane (fresh draft + error each time). */
  const openNudge = (s: { chatId: string; title: string }) => {
    setNudgeTarget({ chatId: s.chatId, title: s.title });
    setNudgeContent('');
    setNudgeError(null);
  };

  /**
   * Send the nudge as a user message into the lane's queue (202 = accepted).
   * Success: toast + close; failure: the error shows INSIDE the dialog and
   * the draft stays so it can be retried.
   */
  const sendNudge = async () => {
    if (!nudgeTarget) return;
    const content = nudgeContent.trim();
    if (!content) return;
    setNudgeSending(true);
    setNudgeError(null);
    try {
      await platformFleetApi.nudgeChat(nudgeTarget.chatId, content);
      toast.success(`Nudge sent to "${nudgeTarget.title}".`);
      setNudgeTarget(null);
    } catch {
      setNudgeError('Could not send the nudge — check your connection and try again.');
    } finally {
      setNudgeSending(false);
    }
  };

  /**
   * Per-project fleet-supervision toggle — optimistic (the row flips/mutes
   * instantly), reverted with an error toast when the API call fails. Off =
   * the project leaves the AUTOMATIC supervision surfaces (wildcard hooks,
   * hourly digests, watchdog alerts); direct hooks + decisions waiting on the
   * user are unaffected.
   */
  const toggleSupervision = async (projectId: string, supervised: boolean) => {
    setOverview((prev) =>
      prev
        ? { ...prev, projects: prev.projects.map((p) => (p.id === projectId ? { ...p, supervised } : p)) }
        : prev,
    );
    try {
      await projectsApi.update(projectId, { supervised });
      toast.success(supervised ? 'Project is supervised again.' : 'Project removed from fleet supervision.');
    } catch {
      setOverview((prev) =>
        prev
          ? { ...prev, projects: prev.projects.map((p) => (p.id === projectId ? { ...p, supervised: !supervised } : p)) }
          : prev,
      );
      toast.error('Could not update supervision.');
    }
  };

  /**
   * Per-project DEDICATED supervisor toggle (2026-09-14) — distinct from
   * toggleSupervision's fleet-wildcard opt-out above: ON scaffolds the
   * project's own supervisor agent (within a minute, fire-and-forget ensure);
   * OFF pauses it (hooks+schedules disabled, history preserved). Optimistic
   * flip, revert + error toast on failure. The field defaults false, so the
   * switch binds `=== true` (checked only on explicit true).
   */
  const toggleProjectSupervisor = async (projectId: string, enabled: boolean) => {
    setOverview((prev) =>
      prev
        ? { ...prev, projects: prev.projects.map((p) => (p.id === projectId ? { ...p, projectSupervisorEnabled: enabled } : p)) }
        : prev,
    );
    try {
      await projectsApi.update(projectId, { projectSupervisorEnabled: enabled });
      toast.success(enabled
        ? 'Project supervisor enabled — it will scaffold within a minute.'
        : 'Project supervisor paused (history preserved).');
    } catch {
      setOverview((prev) =>
        prev
          ? { ...prev, projects: prev.projects.map((p) => (p.id === projectId ? { ...p, projectSupervisorEnabled: !enabled } : p)) }
          : prev,
      );
      toast.error('Could not update the project supervisor.');
    }
  };

  /**
   * Silence one attention item — optimistic (the row mutes/vanishes instantly),
   * reverted with an error toast when the API call fails. snoozeHours=24 → a
   * timed snooze; omitted → an indefinite ack. The silence lives server-side,
   * so it survives the hourly digest regeneration (and other devices).
   */
  const silenceDigestItem = async (item: FleetDigestAttentionItem, snoozeHours?: number) => {
    if (!item.key) {
      // Deploy skew: an old backend serves no keys. Explain, never dead-click.
      toast.error('Silencing needs the updated backend — try again in a moment.');
      return;
    }
    const key = item.key;
    pendingSilences.current.set(key, Date.now() + POLL_MS + 10_000);
    setAckedKeys((prev) => new Set(prev).add(key));
    try {
      await fleetApi.ackDigestItem(key, snoozeHours);
      toast.success(snoozeHours ? 'Snoozed for 24 hours.' : 'Acknowledged — hidden until the condition clears.');
    } catch {
      pendingSilences.current.delete(key);
      setAckedKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
      toast.error('Could not silence the item.');
    }
  };

  /** Lift a silence — optimistic; the item reverts to muted + a toast on failure. */
  const unackDigestItem = async (item: FleetDigestAttentionItem) => {
    if (!item.key) return;
    const key = item.key;
    pendingSilences.current.delete(key);
    setAckedKeys((prev) => { const next = new Set(prev); next.delete(key); return next; });
    try {
      await fleetApi.unackDigestItem(key);
      toast.success('Un-acknowledged — the item is live again.');
    } catch {
      setAckedKeys((prev) => new Set(prev).add(key));
      toast.error('Could not un-acknowledge the item.');
    }
  };

  if (!overview) {
    // Never render fabricated zeroed stats over a failed load — show the
    // error with a retry instead.
    if (error) {
      return (
        <div className="py-12 text-center space-y-3">
          <p className="text-xs text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={() => refresh()}>Retry</Button>
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // `hooks = []` default: an old backend (deploy skew) omits the field entirely.
  const { supervisor, counts, projects, sessions, schedules, hooks = [] } = overview;

  /**
   * Chat deep-links: the supervisor chat is hidden from the main chat UI
   * (Management is its only home — the raw transcript is machine-heavy), so
   * route it to the Supervisor tab instead of /crossmodel?chatId. Link to the
   * canonical /crossmodel path (the root / redirect preserves the query, but
   * skipping the hop is faster and immune to redirect regressions).
   */
  const openChat = (chatId: string) => {
    if (supervisor && chatId === supervisor.id) onGoSupervisor();
    else router.push(`/?chatId=${chatId}`);
  };

  // Schedules hygiene: cancelled/disabled rows linger forever otherwise — the
  // live ones stay visible, the dead ones collapse behind a toggle.
  const activeSchedules = schedules.filter((s) => s.enabled);
  const inactiveSchedules = schedules.filter((s) => !s.enabled);

  // Hint-only wiring warnings (loops / duplicate watchers) — pure derivation,
  // never auto-disables.
  const hints = hookHints(hooks);

  // Gentle duplicate-name detection (trimmed, case-insensitive) — hint only,
  // never auto-merge. Keyed by normalized name so the badge is O(1) per row.
  const projectNameCounts = new Map<string, number>();
  for (const p of projects) {
    const key = p.name.trim().toLowerCase();
    projectNameCounts.set(key, (projectNameCounts.get(key) ?? 0) + 1);
  }
  const isDupeName = (name: string) => (projectNameCounts.get(name.trim().toLowerCase()) ?? 0) > 1;

  // Lane → folder name lookup for the Coding Sessions table enrichment.
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));

  // Project Pulse (owner 2026-09-04): join the hourly digests — already
  // fetched on this same poll for the Project Progress card — by projectId so
  // each project row can render its pulse UNDER the project title.
  const digestByProject = new Map((digests ?? []).map((d) => [d.projectId, d]));

  // Goals board derivation (pure, non-mutating): blocked first, then active.
  const { live: liveGoals } = goalBoardBuckets(goals ?? []);
  const { finished: sortedFinishedGoals } = goalBoardBuckets(finishedGoals ?? []);

  return (
    <div className="space-y-4">
      {/* Loaded-with-error: the cards below show the LAST loaded data, not live truth. */}
      {error && <p className="text-xs text-destructive">{error} Showing the last loaded data.</p>}

      {/* ── PULSE — one-glance framework digest (self-shipping loop) ── */}
      {pulse && (() => {
        const blocked = (digests ?? []).some((d) => d.status === 'blocked');
        const attention = (digests ?? []).some((d) => d.status === 'needs_attention');
        // Owner confusion 2026-09-15 ("the dashboard shows CanLaw is halted
        // waiting on me … i dont see anything in my inbox"): a project whose
        // blocked todos are MACHINE halts (a rule the owner set, a dependency)
        // lit this headline as "needs you". Only an item that actually waits
        // on the owner (a lane awaiting input) may say so; a plain block is
        // reported as blocked work the machines own.
        const ownerActionable = (digests ?? []).some((d) => (d.attentionItems ?? []).some((a) => a.kind === 'awaiting_input'));
        // Evidence-guard health is ADMIN-only (ticket 24dd04d5): pulse.guard is
        // null for a non-admin viewer and the tile simply does not render.
        const guard = pulse.guard;
        const guardQuiet = guard ? guard.catches24h === 0 : false;
        const silentFor = guard?.lastCatchAt
          ? relativeTime(guard.lastCatchAt)
          : 'ever';
        const dep = pulse.shipping?.latestDeploy ?? null;
        return (
          <Card className={`py-3 ${blocked ? 'border-destructive/50' : attention ? 'border-warn/50' : 'border-success-accent/30'}`}>
            <CardContent className="px-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Activity className={`size-4 ${blocked ? 'text-destructive' : attention ? 'text-warn-ink' : 'text-success-accent'}`} />
                  <span className="text-sm font-semibold">
                    {blocked && ownerActionable ? 'Blocked work needs you' : blocked ? 'Some work is blocked — the machines are on it' : attention ? 'Shipping — a few items need attention' : 'All systems shipping'}
                  </span>
                </div>
                <span className="text-[10px] text-muted-foreground">pulse {relativeTime(pulse.generatedAt)}</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                <PulseTile icon={Play} label="Sessions running" value={counts.runningSessions ?? sessions.filter((s) => s.running).length} />
                {pulse.shipping && (
                  <PulseTile icon={GitMerge} label="PRs merged today" value={pulse.shipping.mergedToday}
                    sub={`${pulse.shipping.openPrs} open`} tone={pulse.shipping.openPrs > 2 ? 'warn' : undefined}
                    href={`https://github.com/${pulse.shipping.repo}/pulls`} />
                )}
                {dep && (
                  <PulseTile icon={Rocket} label="Last deploy" value={deployBadge(dep)} sub={relativeTime(dep.at)}
                    tone={dep.status === 'completed' && dep.conclusion !== 'success' && dep.conclusion !== 'cancelled' ? 'bad' : undefined}
                    href={dep.url || undefined} />
                )}
                {pulse.queue && (
                  <PulseTile icon={Ticket} label="Ticket queue" value={`${pulse.queue.open + pulse.queue.inProgress} open`}
                    sub={`${pulse.queue.doneToday} closed today · ${pulse.queue.doneTotal} all-time`}
                    tone={pulse.queue.open + pulse.queue.inProgress > 15 ? 'warn' : undefined}
                    onClick={() => document.getElementById('fleet-queue-section')?.scrollIntoView({ behavior: 'smooth' })} />
                )}
                {/* Long-form receipts detail lives in the hover tooltip; the
                    subline stays short and WRAPS (no mid-parenthesis cuts —
                    the "receipts 24h: 3794 (100 failed…" truncation report).
                    ADMIN-only internals (ticket 24dd04d5): pulse.guard is null
                    for a non-admin viewer — the tile does not render. */}
                {pulse.guard && (
                  <PulseTile icon={ShieldCheck} label="Evidence guard"
                    value={guardQuiet ? 'Silent' : `${pulse.guard.catches24h} catches`}
                    title={pulse.guard.receipts
                      ? `Receipts last 24h: ${pulse.guard.receipts.total24h} total, ${pulse.guard.receipts.failed24h} failed`
                        + (pulse.guard.receipts.topTools24h.length > 0
                          ? ` — top tools: ${pulse.guard.receipts.topTools24h.join(', ')}`
                          : '')
                      : undefined}
                    sub={<>
                      {guardQuiet ? `last catch ${silentFor}` : 'last 24h'}
                      {pulse.guard.receipts && (
                        <span className="block">
                          {pulse.guard.receipts.total24h} receipts · {pulse.guard.receipts.failed24h} failed
                        </span>
                      )}
                    </>}
                    tone={guardQuiet ? 'ok' : 'warn'} />
                )}
                <PulseTile icon={Clock} label="Active schedules" value={overview.counts.enabledSchedules}
                  sub={(() => {
                    // REAL counts (owner bug 2026-09-04): the schedules list is
                    // capped at 100 rows, and disabled rows' stale nextRunAt
                    // sorted them into the whole window — the tile showed
                    // "0 active" while ~20 live schedules sat past the cap.
                    const inactive = Math.max(0, ((overview.counts as any).totalSchedules ?? schedules.length) - overview.counts.enabledSchedules);
                    return inactive ? `${inactive} inactive` : undefined;
                  })()} />
              </div>
            </CardContent>
          </Card>
        );
      })()}

      {/* Supervisor — a single slim borderless row (owner polish 2026-09-03:
          the old card said "Fleet Supervisor" twice around one badge). Same
          information, one line: status + queue + coding badges survive, and
          "Open chat" is the click-through to the Supervisor Chat tab. */}
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Gauge className="size-4 text-muted-foreground shrink-0" />
        {supervisor ? (
          <>
            <span className="text-sm font-medium truncate">{supervisor.title}</span>
            {supervisor.running
              ? <Badge variant="success" className="text-[10px]">Running</Badge>
              : <Badge variant="secondary" className="text-[10px]">Idle</Badge>}
            {counts.queuedMessages > 0 && (
              <Badge variant="warning" className="text-[10px]">{counts.queuedMessages} queued</Badge>
            )}
            {supervisor.codingStatus && (
              <Badge variant="outline" className="text-[10px]">{supervisor.codingStatus}</Badge>
            )}
            <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={onGoSupervisor}>
              Open chat
            </Button>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            Fleet Supervisor: not configured — pick a chat as your fleet supervisor in the Supervisor Chat tab.
          </span>
        )}
      </div>

      {/* Fleet summary — the supervisor's latest wake note (Issue 7). THE hero
          card (owner polish 2026-09-03): directly under the pulse strip, above
          everything else. */}
      {fleetSummary?.note && <FleetSummaryCard summary={fleetSummary} onOpenWake={onOpenWake} onGoSupervisor={onGoSupervisor} />}

      {/* Goals — the live work breakdown (blocked first, then active). Todos
          lazy-load per goal on expand; finished goals sit behind a toggle. */}
      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <ListChecks className="size-4 text-muted-foreground" />
            Goals
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 space-y-2">
          {goalsError ? (
            <p className="text-xs text-muted-foreground">{goalsError}</p>
          ) : goals === null ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {liveGoals.length === 0 && (
                <p className="text-xs text-muted-foreground">No active goals.</p>
              )}
              {liveGoals.map((g) => {
                const { done, total } = todoProgress(g);
                const expanded = expandedGoals.has(g.id);
                const todos = goalTodos[g.id];
                return (
                  <div key={g.id} className="rounded-md border border-border px-3 py-2 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => toggleGoal(g.id)}
                        aria-label={expanded ? `Collapse todos for ${g.title}` : `Expand todos for ${g.title}`}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                      </button>
                      {g.status === 'blocked'
                        ? <Badge variant="destructive" className="text-[10px]">Blocked</Badge>
                        : <Badge variant="default" className="text-[10px]">Active</Badge>}
                      {g.projectName && (
                        <Badge variant="outline" className="text-[10px] max-w-[30%] truncate">{g.projectName}</Badge>
                      )}
                      <span className="text-xs font-medium truncate">{g.title}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground shrink-0 tabular-nums">
                        {done}/{total}
                      </span>
                    </div>
                    {expanded && (
                      <div className="space-y-1 border-t border-border/60 pt-1.5">
                        {goalTodosFailed.has(g.id) ? (
                          <p className="text-[11px] text-muted-foreground">
                            Could not load todos — collapse and re-expand to retry.
                          </p>
                        ) : todos === undefined ? (
                          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <Loader2 className="size-3 animate-spin" /> Loading todos…
                          </div>
                        ) : todos.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground">No todos yet.</p>
                        ) : (
                          todos.map((t) => (
                            <div key={t.id} className="space-y-0.5">
                              <div className="flex items-center gap-1.5 text-[11px]">
                                {t.status === 'done' ? (
                                  <Check className="size-3 shrink-0 text-success" />
                                ) : t.status === 'in_progress' ? (
                                  <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                                ) : t.status === 'blocked' ? (
                                  <Ban className="size-3 shrink-0 text-warn-ink" />
                                ) : (
                                  <Circle className="size-3 shrink-0 text-muted-foreground" />
                                )}
                                <span className={`truncate ${t.status === 'done' ? 'text-muted-foreground line-through' : ''}`}>
                                  {t.title}
                                </span>
                                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                                  {assigneeLabel(t, chatTitles)}
                                </span>
                              </div>
                              {t.status === 'blocked' && t.blockedReason && (
                                <p
                                  className="truncate pl-[18px] text-[10px] text-warn-ink"
                                  title={t.blockedReason}
                                >
                                  {t.blockedReason}
                                </p>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              <button
                type="button"
                onClick={toggleFinishedGoals}
                className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                {showFinishedGoals ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                {showFinishedGoals ? 'Hide' : 'Show'} finished (done/archived)
              </button>
              {showFinishedGoals && (
                finishedGoalsError ? (
                  <p className="text-[11px] text-muted-foreground">{finishedGoalsError}</p>
                ) : sortedFinishedGoals.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    {finishedGoals === null ? 'Loading…' : 'No finished goals.'}
                  </p>
                ) : (
                  sortedFinishedGoals.map((g) => {
                    const { done, total } = todoProgress(g);
                    return (
                      <div key={g.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 opacity-60">
                        <Badge variant="secondary" className="text-[10px]">{g.status}</Badge>
                        {g.projectName && (
                          <Badge variant="outline" className="text-[10px] max-w-[30%] truncate">{g.projectName}</Badge>
                        )}
                        <span className="text-xs font-medium truncate">{g.title}</span>
                        <span className="ml-auto text-[11px] text-muted-foreground shrink-0 tabular-nums">
                          {done}/{total}
                        </span>
                      </div>
                    );
                  })
                )
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Counts. Projects scrolls to the Projects card below (the ticket-queue
          tile's in-page idiom); Chats and Queued messages stay static — the
          management page has no chats surface, and queuedMessages counts
          queue depth across ALL chats (no single in-page home). Never invent
          a route for a tile. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
        <StatCard icon={MessageSquare} label="Chats" value={counts.chats} />
        <StatCard icon={Folder} label="Projects" value={counts.projects}
          onClick={() => document.getElementById('fleet-projects-section')?.scrollIntoView({ behavior: 'smooth' })} />
        <StatCard icon={Inbox} label="Queued messages" value={counts.queuedMessages} />
      </div>

      {/* Project Progress — the hourly per-project digests (severity-sorted) */}
      <Card className="py-4">
        <CardHeader className="px-4">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" />
            Project Progress
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {digestsError ? (
            <p className="text-xs text-muted-foreground">{digestsError}</p>
          ) : digests === null ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : digests.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No digests yet — hourly summaries appear here once your projects have activity.
            </p>
          ) : (
            <div className="space-y-2">
              {digests.map((d) => (
                <DigestBucket
                  key={d.projectId ?? 'ungrouped'}
                  digest={d}
                  ackedKeys={ackedKeys}
                  showAcked={showAcked}
                  onSilence={silenceDigestItem}
                  onUnack={unackDigestItem}
                  onOpenProject={(projectId) => router.push(`/projects/${projectId}`)}
                  onOpenChat={openChat}
                />
              ))}
              {ackedKeys.size > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAcked((v) => !v)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {showAcked ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                  {showAcked ? 'Hide' : 'Show'} {ackedKeys.size} acknowledged
                </button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Projects */}
      <Card className="py-4">
        {/* ── SHIPPING — what the framework merged/deployed (interlinked to GitHub) ── */}
      {pulse?.shipping && (
        <Card className="py-4 gap-2">
          <CardHeader className="px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <GitPullRequest className="size-4 text-muted-foreground" />
              Shipping
              <span className="text-[11px] font-normal text-muted-foreground">{pulse.shipping.repo}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <div className="divide-y divide-border/60">
              {pulse.shipping.recent.slice(0, 8).map((pr) => (
                <a key={pr.number} href={`https://github.com/${pulse.shipping!.repo}/pull/${pr.number}`}
                  target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 py-1.5 group">
                  <span className="font-mono text-[11px] text-muted-foreground w-12 shrink-0">#{pr.number}</span>
                  {prStateBadge(pr.state)}
                  <span className="text-xs truncate flex-1 group-hover:underline">{pr.title}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(pr.at)}</span>
                  <ExternalLink className="size-3 text-muted-foreground/0 group-hover:text-muted-foreground shrink-0" />
                </a>
              ))}
              {pulse.shipping.recent.length === 0 && (
                <p className="text-xs text-muted-foreground py-2">No recent pull requests.</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── TICKET QUEUE — open work flowing through the lane ── */}
      {pulse?.queue && (
        <Card className="py-4 gap-2" id="fleet-queue-section">
          <CardHeader className="px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <Ticket className="size-4 text-muted-foreground" />
              Ticket queue
              <span className="text-[11px] font-normal text-muted-foreground">
                {pulse.queue.open} open · {pulse.queue.inProgress} in progress · {pulse.queue.doneToday} closed today
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <div className="divide-y divide-border/60">
              {pulse.queue.openList.map((t) => (
                <div key={t.id} className="flex items-center gap-2 py-1.5">
                  {t.source === 'agent'
                    ? <Sparkles className="size-3.5 text-muted-foreground shrink-0" />
                    : <UserIcon className="size-3.5 text-brand-accent shrink-0" />}
                  {t.status === 'in_progress'
                    ? <Badge variant="warning" className="text-[10px] shrink-0">in progress</Badge>
                    : <Badge variant="outline" className="text-[10px] shrink-0">open</Badge>}
                  <span className="text-xs truncate flex-1" title={t.title}>{t.title}</span>
                  <span className="font-mono text-[10px] text-muted-foreground shrink-0">{t.id.slice(0, 8)}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(t.createdAt)}</span>
                </div>
              ))}
              {pulse.queue.openList.length === 0 && (
                <p className="text-xs text-muted-foreground py-2">Queue is clear — nothing open.</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <CardHeader className="px-4" id="fleet-projects-section">
          <CardTitle className="text-sm">Projects</CardTitle>
        </CardHeader>
        <CardContent className="px-4">
          {projects.length === 0 ? (
            <p className="text-xs text-muted-foreground">No projects yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Name</TableHead>
                  <TableHead className="text-xs w-16 text-right">Chats</TableHead>
                  <TableHead className="text-xs w-20 text-right">Running</TableHead>
                  <TableHead className="text-xs w-24 text-right">Supervised</TableHead>
                  <TableHead className="text-xs w-24 text-right">Supervisor</TableHead>
                  <TableHead className="text-xs w-24 text-right">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((p) => (
                  <TableRow
                    key={p.id}
                    className={`cursor-pointer ${p.supervised === false ? 'opacity-60' : ''}`}
                    onClick={() => router.push(`/projects/${p.id}`)}
                  >
                    <TableCell className="text-xs">
                      <span className="mr-1.5">{p.emoji || '📁'}</span>
                      <span className="font-medium">{p.name}</span>
                      {p.supervised === false && (
                        <Badge variant="secondary" className="ml-2 text-[10px]">Not supervised</Badge>
                      )}
                      {isDupeName(p.name) && (
                        <Popover>
                          {/* stopPropagation: the row itself navigates on click */}
                          <PopoverTrigger className="ml-2 cursor-pointer align-middle" onClick={(e) => e.stopPropagation()}>
                            <Badge variant="warning" className="text-[10px]">dupe?</Badge>
                          </PopoverTrigger>
                          <PopoverContent side="top" className="w-72 p-3 text-xs">
                            Another project has the same name — consider renaming or merging them
                            (Digby never merges automatically).
                          </PopoverContent>
                        </Popover>
                      )}
                      {/* Project Pulse UNDER the project title (owner 2026-09-04):
                          hourly summary + goal-progress/ETA chips, joined from the
                          digests this poll already fetched. Unsupervised projects
                          have no digest by design — no pulse line for them. */}
                      {p.supervised !== false && (
                        <ProjectPulse digest={digestByProject.get(p.id) ?? null} compact className="mt-1" />
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-right text-muted-foreground">{p.chatCount}</TableCell>
                    <TableCell className="text-right">
                      {p.runningCount > 0
                        ? <Badge variant="success" className="text-[10px]">{p.runningCount}</Badge>
                        : <span className="text-xs text-muted-foreground">—</span>}
                    </TableCell>
                    {/* stopPropagation: toggling must not trigger the row navigation */}
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={p.supervised !== false}
                        onCheckedChange={(v) => toggleSupervision(p.id, v)}
                        aria-label={`Fleet supervision for ${p.name}`}
                        title={p.supervised !== false
                          ? 'Supervised — the fleet supervisor watches this project (hooks, digests, alerts)'
                          : 'Not supervised — click to put this project back under fleet supervision'}
                      />
                    </TableCell>
                    {/* stopPropagation: toggling must not trigger the row navigation.
                        Defaults false — checked only on explicit true (unlike
                        supervised's !== false above). */}
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={p.projectSupervisorEnabled === true}
                        onCheckedChange={(v) => toggleProjectSupervisor(p.id, v)}
                        aria-label={`Project supervisor (dedicated agent for this project): ${p.name}`}
                        title="Project supervisor (dedicated agent for this project)"
                      />
                    </TableCell>
                    <TableCell className="text-xs text-right text-muted-foreground">{relativeTime(p.updatedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Coding sessions */}
      {sessions.length > 0 && (
        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Coding Sessions</CardTitle>
          </CardHeader>
          <CardContent className="px-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Session</TableHead>
                  <TableHead className="text-xs w-28">Ticket / PR</TableHead>
                  <TableHead className="text-xs w-24">Status</TableHead>
                  <TableHead className="text-xs">Branch</TableHead>
                  <TableHead className="text-xs w-28">Model</TableHead>
                  <TableHead className="text-xs w-24 text-right">Updated</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => {
                  const refs = extractWorkRefs(s.title);
                  const projectName = s.projectId ? projectNameById.get(s.projectId) : undefined;
                  return (
                    <TableRow
                      key={s.chatId}
                      className="cursor-pointer"
                      onClick={() => openChat(s.chatId)}
                    >
                      <TableCell className="text-xs font-medium max-w-[160px] truncate">
                        <div className="truncate">{s.title}</div>
                        {projectName && (
                          <div className="truncate text-[10px] font-normal text-muted-foreground">{projectName}</div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[140px]">
                        {refs.prs.length === 0 && refs.tickets.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {refs.prs.map((ref) => (
                              <Badge key={ref} variant="outline" className="font-mono text-[10px] gap-0.5">
                                <GitPullRequest className="size-2.5" />
                                {ref}
                              </Badge>
                            ))}
                            {refs.tickets.map((ref) => (
                              <Badge key={ref} variant="outline" className="font-mono text-[10px] gap-0.5">
                                <Ticket className="size-2.5" />
                                {ref}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>{sessionStatusBadge(s.status, s.running)}</TableCell>
                      <TableCell className="text-xs font-mono max-w-[140px] truncate text-muted-foreground">
                        {s.branch || '—'}
                      </TableCell>
                      <TableCell className="text-xs max-w-[112px] truncate text-muted-foreground">{s.model || '—'}</TableCell>
                      <TableCell className="text-xs text-right text-muted-foreground">{relativeTime(s.updatedAt)}</TableCell>
                      {/* stopPropagation: nudging must not trigger the row navigation */}
                      <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          title="Nudge this lane — send a message into its queue"
                          aria-label={`Nudge ${s.title}`}
                          onClick={() => openNudge(s)}
                          className="rounded p-1 text-muted-foreground hover:text-foreground cursor-pointer"
                        >
                          <MessageSquare className="size-3.5" />
                        </button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Schedules — live rows always visible (+ one-click cancel); dead
          (disabled/cancelled) rows collapse behind a toggle so they stop
          flooding the card on long-lived accounts. */}
      {schedules.length > 0 && (
        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm">Schedules</CardTitle>
          </CardHeader>
          <CardContent className="px-4 space-y-2">
            {activeSchedules.map((s) => (
              <div key={s.id} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium truncate">{s.chatTitle || 'Deleted chat'}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {s.kind === 'once' ? 'once' : formatInterval(s.intervalSec) || 'recurring'}
                    </Badge>
                    {scheduleStatusBadge(s.lastStatus)}
                  </div>
                  <p className="text-[11px] text-muted-foreground truncate mt-0.5">{s.promptSnippet}</p>
                </div>
                <div className="text-[11px] text-muted-foreground text-right shrink-0">
                  <div>{s.nextRunAt ? relativeTime(s.nextRunAt) : '—'}</div>
                  <div className="text-[10px]">{s.runsCount} run{s.runsCount === 1 ? '' : 's'}</div>
                </div>
                <button
                  type="button"
                  title="Cancel this schedule (stops firing; kept for history)"
                  aria-label="Cancel schedule"
                  disabled={cancellingScheduleId === s.id}
                  onClick={() => setConfirmSchedule({ id: s.id, snippet: s.promptSnippet })}
                  className="shrink-0 self-center rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-40"
                >
                  {cancellingScheduleId === s.id ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                </button>
              </div>
            ))}
            {activeSchedules.length === 0 && (
              <p className="text-[11px] text-muted-foreground">No active schedules.</p>
            )}
            {inactiveSchedules.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setShowInactiveSchedules((v) => !v)}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                >
                  {showInactiveSchedules ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                  {showInactiveSchedules ? 'Hide' : 'Show'} {inactiveSchedules.length} inactive
                </button>
                {showInactiveSchedules && inactiveSchedules.map((s) => (
                  <div key={s.id} className="flex items-start gap-3 rounded-md border border-border px-3 py-2 opacity-60">
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium truncate">{s.chatTitle || 'Deleted chat'}</span>
                        <Badge variant="outline" className="text-[10px]">
                          {s.kind === 'once' ? 'once' : formatInterval(s.intervalSec) || 'recurring'}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px]">disabled</Badge>
                        {scheduleStatusBadge(s.lastStatus)}
                      </div>
                      <p className="text-[11px] text-muted-foreground truncate mt-0.5">{s.promptSnippet}</p>
                    </div>
                    <div className="text-[11px] text-muted-foreground text-right shrink-0">
                      <div className="text-[10px]">{s.runsCount} run{s.runsCount === 1 ? '' : 's'}</div>
                    </div>
                  </div>
                ))}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Hooks */}
      {hooks.length > 0 && (
        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="text-sm flex items-center gap-2">
              <Webhook className="size-4 text-muted-foreground" />
              Hooks
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 space-y-2">
            {hooks.map((h: FleetHookRow) => (
              <div key={h.id} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium truncate">
                      {h.sourceChatId && h.sourceTitle ? (
                        <button
                          type="button"
                          onClick={() => openChat(h.sourceChatId!)}
                          className="hover:underline cursor-pointer"
                          title={`Open chat: ${h.sourceTitle}`}
                        >
                          {h.sourceTitle}
                        </button>
                      ) : (
                        h.sourceTitle ?? 'All chats'
                      )}
                      {' → '}
                      {h.targetTitle ? (
                        <button
                          type="button"
                          onClick={() => openChat(h.targetChatId)}
                          className="hover:underline cursor-pointer"
                          title={`Open chat: ${h.targetTitle}`}
                        >
                          {h.targetTitle}
                        </button>
                      ) : (
                        'Deleted chat'
                      )}
                    </span>
                    {h.eventTypes.map((et) => (
                      <Badge key={et} variant="outline" className="text-[10px]">{et}</Badge>
                    ))}
                    {!h.enabled && <Badge variant="secondary" className="text-[10px]">disabled</Badge>}
                    {(hints.get(h.id) ?? []).map((reason) => (
                      // Popover, not title-attr: the reason must be reachable on
                      // tap (title tooltips never show on touch devices).
                      <Popover key={reason}>
                        <PopoverTrigger className="cursor-pointer">
                          <Badge
                            variant="outline"
                            className="text-[10px] border-warn/60 text-warn-ink gap-0.5"
                          >
                            <AlertTriangle className="size-2.5" />
                            {reason.startsWith('Possible loop') ? 'loop?' : 'dupe?'}
                          </Badge>
                        </PopoverTrigger>
                        <PopoverContent side="top" className="w-72 p-3 text-xs">{reason}</PopoverContent>
                      </Popover>
                    ))}
                  </div>
                </div>
                <div className="text-[11px] text-muted-foreground text-right shrink-0">
                  <div>{h.lastFiredAt ? relativeTime(h.lastFiredAt) : 'never'}</div>
                  <div className="text-[10px]">last fired</div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Schedule-cancel confirm — the app's dialog pattern, not window.confirm
          (which is unstylable and blocks the poll loop). */}
      <AlertDialog
        open={confirmSchedule !== null}
        onOpenChange={(open) => { if (!open) setConfirmSchedule(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this schedule?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{confirmSchedule?.snippet}&rdquo; — it will stop firing (the row is kept for history).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep schedule</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => { if (confirmSchedule) cancelSchedule(confirmSchedule.id); }}
            >
              Cancel schedule
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Nudge-a-lane — sends a user message into the lane's queue (the same
          owner-scoped platform endpoint the REST API exposes; nothing new). */}
      <Dialog
        open={nudgeTarget !== null}
        onOpenChange={(open) => { if (!open && !nudgeSending) setNudgeTarget(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="truncate">Nudge &ldquo;{nudgeTarget?.title}&rdquo;</DialogTitle>
            <DialogDescription>
              The message is sent as you into the lane&rsquo;s queue — it picks it up on its next turn.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={nudgeContent}
            onChange={(e) => setNudgeContent(e.target.value)}
            placeholder="Nudge message — sent as you into the lane's queue"
            rows={3}
            disabled={nudgeSending}
            autoFocus
          />
          {nudgeError && <p className="text-xs text-destructive">{nudgeError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => setNudgeTarget(null)} disabled={nudgeSending}>
              Cancel
            </Button>
            <Button onClick={sendNudge} disabled={nudgeSending || !nudgeContent.trim()}>
              {nudgeSending && <Loader2 className="size-3.5 animate-spin" />}
              Send
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
