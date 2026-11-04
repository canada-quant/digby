'use client';

/**
 * TaskCard — the ONE live card for a task's lifecycle in the chat it was
 * asked in (cohesive chat, 2026-09-28; contract lib/task-card.ts, backend
 * twin chat-agent/task-events.ts). It replaces prose like "Deck build is
 * staged and waiting on your one click" with harness facts only:
 *
 *   title · kind badge (Continuing / Sub-session / Scheduled) · status pill
 *   (Working / Done / Failed / Waiting for you) · steps done/total · receipts
 *   ok/total · spend · started + elapsed (a live clock while running) · the
 *   harness ETA text when present · on done the artifacts (files with
 *   download links, PRs, canvases) + "Open result" (jumps to the result
 *   message) · on waiting_user the question the harness relayed + "Reply
 *   below" (focuses the composer).
 *
 * Rendered as a transcript PART (AssistantParts) so the live stream, the
 * reloaded row and the guest-resume path all show the same card. Actions come
 * from TaskCardActionsContext (the session view provides them); with no
 * provider the card is inert but complete (SSR / tests).
 *
 * TaskResultSection is the sub-session view's "Result" block: the same
 * artifacts + links at the top of a finished session instead of only a dry
 * status line.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import { useMinimalView } from '@/lib/view-mode';
import {
  ArrowDownToLine, Check, ChevronDown, ChevronRight, CircleAlert, ExternalLink, FileText,
  GitPullRequest, HelpCircle, LayoutTemplate, Loader2, MessageSquare, Repeat, Workflow,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  OPEN_RESULT_LABEL, OPEN_SESSION_LABEL, REPLY_BELOW_LABEL, RESULT_SECTION_LABEL,
  TASK_KIND_LABEL, TASK_STATUS_LABEL, formatBytes, formatDurationShort, formatSpend,
  type TaskArtifact, type TaskEventPayload,
} from '@/lib/task-card';

export interface TaskCardActions {
  /** Jump to the assistant row the result was posted as. */
  openResult?: (messageId: string) => void;
  /** Focus the composer (a 'waiting_user' card asks the user to reply). */
  focusComposer?: () => void;
  /** Open the spawned sub-session (kind 'session'). */
  openChat?: (chatId: string) => void;
}

export const TaskCardActionsContext = createContext<TaskCardActions>({});

/** Isolated 1 s clock for the running card — never re-renders the transcript. */
function ElapsedSince({ since }: { since: string }) {
  const start = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!Number.isFinite(start)) return null;
  return <>{formatDurationShort(now - start)}</>;
}

function KindBadge({ kind }: { kind: TaskEventPayload['kind'] }) {
  const Icon = kind === 'session' ? Workflow : kind === 'schedule' ? Repeat : MessageSquare;
  return (
    <span data-task-kind={kind} className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/30 px-2 h-5 text-[10px] font-medium text-muted-foreground select-none">
      <Icon className="size-2.5" />
      {TASK_KIND_LABEL[kind]}
    </span>
  );
}

function StatusPill({ status }: { status: TaskEventPayload['status'] }) {
  const base = 'inline-flex items-center gap-1 rounded-full border px-2 h-5 text-[10px] font-medium select-none';
  if (status === 'running') {
    return <span data-task-status="running" className={cn(base, 'border-line bg-hover text-ink-2')}><Loader2 className="size-2.5 animate-spin" />{TASK_STATUS_LABEL.running}</span>;
  }
  if (status === 'done') {
    return <span data-task-status="done" className={cn(base, 'border-success-border bg-success-soft text-success-strong')}><Check className="size-2.5" />{TASK_STATUS_LABEL.done}</span>;
  }
  if (status === 'failed') {
    return <span data-task-status="failed" className={cn(base, 'border-destructive/50 bg-destructive/10 text-destructive')}><CircleAlert className="size-2.5" />{TASK_STATUS_LABEL.failed}</span>;
  }
  return <span data-task-status="waiting_user" className={cn(base, 'border-warn/70 bg-warn/10 text-warn-ink dark:border-warn/60')}><HelpCircle className="size-2.5" />{TASK_STATUS_LABEL.waiting_user}</span>;
}

function ArtifactIcon({ kind }: { kind: TaskArtifact['kind'] }) {
  if (kind === 'pr') return <GitPullRequest className="size-3 shrink-0 text-ink-3" />;
  if (kind === 'canvas') return <LayoutTemplate className="size-3 shrink-0 text-ink-3" />;
  return <FileText className="size-3 shrink-0 text-ink-3" />;
}

/** The deliverables list — files download, PRs open in a new tab, canvases open their link. */
export function TaskArtifactList({ artifacts, className }: { artifacts: TaskArtifact[]; className?: string }) {
  if (!artifacts.length) return null;
  return (
    <ul data-task-artifacts className={cn('space-y-1', className)}>
      {artifacts.map((a, i) => {
        const size = formatBytes(a.bytes);
        const label = (
          <>
            <ArtifactIcon kind={a.kind} />
            <span className="truncate min-w-0">{a.name}</span>
            {size && <span className="shrink-0 text-[10px] text-muted-foreground/80 tabular-nums">{size}</span>}
          </>
        );
        if (!a.url) {
          return <li key={`${a.kind}:${a.name}:${i}`} className="flex items-center gap-1.5 text-xs text-foreground/80 min-w-0">{label}</li>;
        }
        const external = a.kind === 'pr' || /^https?:\/\//i.test(a.url);
        return (
          <li key={`${a.kind}:${a.name}:${i}`} className="min-w-0">
            <a
              href={a.url}
              {...(a.kind === 'file' && !external ? { download: a.name } : {})}
              {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              data-task-artifact={a.kind}
              className="inline-flex max-w-full items-center gap-1.5 text-xs text-ink underline decoration-line-2 underline-offset-[3px] hover:decoration-ink-3 min-w-0"
            >
              {label}
              {a.kind === 'file' && !external ? <ArrowDownToLine className="size-3 shrink-0 opacity-70" /> : <ExternalLink className="size-3 shrink-0 opacity-70" />}
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export interface TaskCardProps {
  task: TaskEventPayload;
}

export function TaskCard({ task }: TaskCardProps) {
  const actions = useContext(TaskCardActionsContext);
  // Minimal view (2026-10-16): title, status, result files and the actions — no steps, receipts, spend or ETA.
  const minimal = useMinimalView();
  const running = task.status === 'running';
  const waiting = task.status === 'waiting_user';
  const settled = task.status === 'done' || task.status === 'failed';
  const spend = formatSpend(task.spendUsd);
  const started = Date.parse(task.startedAt);
  const updated = Date.parse(task.updatedAt);
  const took = settled && Number.isFinite(started) && Number.isFinite(updated) && updated >= started ? formatDurationShort(updated - started) : '';
  const startedLabel = Number.isFinite(started) ? new Date(started).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const showArtifacts = task.artifacts.length > 0;

  return (
    <div
      data-task-card={task.status}
      data-task-id={task.taskId}
      className={cn(
        'my-2 rounded-lg border p-3 text-xs',
        waiting ? 'border-warn/60 bg-warn/10 dark:bg-warn/8' : task.status === 'failed' ? 'border-destructive/40 bg-destructive/6 dark:bg-destructive/8' : 'border-border/70 bg-muted/20',
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
        <span className="font-medium text-foreground truncate min-w-0 flex-1 basis-40" title={task.title}>{task.title}</span>
        <KindBadge kind={task.kind} />
        <StatusPill status={task.status} />
      </div>

      {/* Harness facts row — every number here is the server's, never the model's. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground tabular-nums">
        {!minimal && task.steps.total > 0 && <span data-task-steps>Steps {task.steps.done}/{task.steps.total}</span>}
        {!minimal && task.receipts.total > 0 && <span data-task-receipts>Receipts {task.receipts.ok}/{task.receipts.total}</span>}
        {!minimal && spend && <span data-task-spend>{spend}</span>}
        {startedLabel && (
          <span data-task-clock>
            Started {startedLabel}
            {running && <> · <ElapsedSince since={task.startedAt} /></>}
            {took && <> · took {took}</>}
          </span>
        )}
        {!minimal && task.etaText && !settled && <span data-task-eta className="text-foreground/80">{task.etaText}</span>}
      </div>

      {/* A note the harness attached — for waiting_user it is the question itself. */}
      {task.note && (
        <div data-task-note className={cn('mt-2 whitespace-pre-wrap break-words leading-relaxed', waiting ? 'text-foreground' : 'text-muted-foreground')}>
          {task.note}
        </div>
      )}

      {showArtifacts && <TaskArtifactList artifacts={task.artifacts} className="mt-2" />}

      {(waiting || task.resultMessageId || task.childChatId) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {waiting && (
            <button
              type="button"
              data-task-action="reply"
              onClick={() => actions.focusComposer?.()}
              className="inline-flex items-center gap-1 rounded-md bg-send px-2.5 py-1 text-[11px] font-medium text-send-ink hover:bg-send/90 transition-colors"
            >
              <MessageSquare className="size-3" /> {REPLY_BELOW_LABEL}
            </button>
          )}
          {task.resultMessageId && (
            <button
              type="button"
              data-task-action="open-result"
              onClick={() => { if (task.resultMessageId) actions.openResult?.(task.resultMessageId); }}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted transition-colors"
            >
              <ChevronDown className="size-3" /> {OPEN_RESULT_LABEL}
            </button>
          )}
          {task.childChatId && actions.openChat && (
            <button
              type="button"
              data-task-action="open-session"
              onClick={() => { if (task.childChatId) actions.openChat?.(task.childChatId); }}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-muted transition-colors"
            >
              <Workflow className="size-3" /> {OPEN_SESSION_LABEL}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The sub-session view's Result section: shown at the top of a finished
 * session (same artifacts + links as the parent's card) so the deliverable is
 * the first thing a visitor sees — not a status line. Collapsible; open by
 * default.
 */
export function TaskResultSection({ task, defaultOpen = true }: { task: TaskEventPayload; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const actions = useContext(TaskCardActionsContext);
  const failed = task.status === 'failed';
  const count = task.artifacts.length;
  const summary = failed
    ? 'The run did not finish'
    : count ? `${count} deliverable${count === 1 ? '' : 's'}` : 'No files handed back';
  return (
    <section
      data-task-result={task.status}
      className={cn('mb-3 rounded-lg border px-3 py-2 text-xs', failed ? 'border-destructive/40 bg-destructive/6 dark:bg-destructive/8' : 'border-success-border bg-success-soft/40')}
    >
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 text-left"
      >
        {open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />}
        {failed ? <CircleAlert className="size-3.5 shrink-0 text-destructive" /> : <Check className="size-3.5 shrink-0 text-success-strong" />}
        <span className="font-medium text-foreground">{RESULT_SECTION_LABEL}</span>
        <span className="text-muted-foreground truncate min-w-0">· {task.title} · {summary}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {task.note && <p className="whitespace-pre-wrap break-words text-muted-foreground leading-relaxed">{task.note}</p>}
          <TaskArtifactList artifacts={task.artifacts} />
          {task.resultMessageId && actions.openResult && (
            <button
              type="button"
              data-task-action="open-result"
              onClick={() => { if (task.resultMessageId) actions.openResult?.(task.resultMessageId); }}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted transition-colors"
            >
              <ChevronDown className="size-3" /> {OPEN_RESULT_LABEL}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
