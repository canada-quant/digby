'use client';

/**
 * Shared agent-transcript primitives (One-Digby consolidation, 2026-07-15).
 * Extracted verbatim from code/page.tsx so the MAIN chat surface and the code
 * session view render agent work identically: tool cards, reasoning blocks,
 * plan checklists, diff coloring, and the ordered parts renderer.
 */

import { createContext, memo, useContext, useEffect, useState } from 'react';
import { displayModelName, SEAT_LABELS } from '../model-display';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { MarkdownContent } from '@/components/ui/custom/prompt/markdown-content';
import { ExpandableDataImage } from '@/components/ui/custom/prompt/expandable-data-image';
import { resolveSourceUrl, sourceDisplayHost } from '@/lib/source-url';
import { MessagePart, PlainMessageMeta } from '@/lib/api/coding';
import { groupProseParts, proseGroupText, type ProseGroupItem } from '@/lib/prose-grouping';
import { splitHarnessChrome } from '@/lib/harness-chrome';
import { stripToolMarkupForRender } from '@/lib/tool-markup';
import { classifyAssistantCard, isMachineStampOrigin } from '@/lib/machine-wake';
import { localizeUtcTimes } from '@/lib/localize-utc-times';
import VerificationFooter from './VerificationFooter';
import OwnerInboxCard from './OwnerInboxCard';
import ProjectStatusCard from './ProjectStatusCard';
import { TaskCard } from './TaskCard';
import { taskOfPart } from '@/lib/task-card';
import { groupToolActivityItems, pairToolActions, toolActivityLabel, type ToolActivityItem } from '@/lib/tool-activity-grouping';
import { formatMessageTime } from '@/lib/format-message-time';
import { googleApi, voiceApi, feedbackApi, filesApi, type GoogleAccount, type FeedbackReason } from '@/lib/api/crossmodel';
import type { TextSizeClasses } from '@/lib/preferences';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { reasoningVisible } from '@/lib/reasoning-visibility';
import { useMinimalView } from '@/lib/view-mode';
import { buildMinimalItems, groupMinimalLines, type ActivityKind, type ActivityLine, type ActivityRow } from '@/lib/minimal-activity';

import {
  Github, Wrench, Terminal, FileEdit, Search, Users, ChevronDown, ChevronRight,
  ListChecks, CheckCheck, Play, Square, Activity,
  CheckCircle2, XCircle, AlertCircle, Globe, Mail, MailCheck, Send, Pencil, Check, X, Loader2, Brain, Zap,
  Copy, CopyCheck, Volume2, VolumeX, ThumbsDown, ThumbsUp, RotateCcw, CornerDownRight, Download, ExternalLink,
} from 'lucide-react';

/**
 * Filename for a generated image's Download action (2026-09-24). The
 * transcript part carries no filename — `name` is the caption ("Generated ·
 * 1024×1024 · "…"") — so derive one from the file id + sniffed mime.
 */
export function generatedImageFilename(part: { fileId?: string; mediaType?: string }): string {
  const ext = part.mediaType === 'image/jpeg' ? 'jpg' : part.mediaType === 'image/webp' ? 'webp' : 'png';
  return `image-${(part.fileId || 'generated').slice(0, 8)}.${ext}`;
}

/**
 * Download / Open row under a generated image figure (2026-09-24). Download
 * rides the authed fetch → blob → <a download> flow (filesApi.downloadGenerated,
 * the Files page idiom — the Bearer route 401s on a bare navigation); Open
 * targets the inline byte route in a new tab (the cookie/query-token twin
 * route serves image/* without a Bearer header). Ghost icon buttons in the
 * FileLinkCard idiom.
 */
export function GeneratedImageActions({ part }: { part: MessagePart }) {
  const [busy, setBusy] = useState(false);
  const fileId = part.fileId || '';
  const filename = generatedImageFilename(part);
  const download = async () => {
    if (busy || !fileId) return;
    setBusy(true);
    try {
      await filesApi.downloadGenerated(fileId, filename);
    } catch {
      toast.error('Failed to download image');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 flex items-center gap-0.5" data-generated-image-actions={fileId}>
      <Button
        variant="ghost" size="icon" className="h-7 w-7"
        title={`Download ${filename}`} aria-label={`Download ${filename}`}
        disabled={busy} onClick={() => void download()}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      </Button>
      <Button
        variant="ghost" size="icon" className="h-7 w-7"
        title="Open image in a new tab" aria-label="Open image in a new tab"
        onClick={() => { if (fileId) window.open(filesApi.inlineGeneratedUrl(fileId), '_blank', 'noopener'); }}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

/** Human elapsed time: 8s · 1m 04s · 12m 30s. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}

/**
 * "Add to project knowledge" row under a gmail_get_attachment tool card
 * (ticket 99145890). The attachment the agent just read can be filed into a
 * project's knowledge base without a re-upload: pick a folder, click Add, the
 * backend re-fetches it by messageId+filename through the SAME download path
 * and ingests it (vision hop for images, PDF/DOCX extraction for documents).
 * Server-side dedup: same messageId+filename = one document, a repeat add
 * answers duplicate:true.
 *
 * Rendered only when the tool call carries BOTH a messageId and a filename
 * (the stable handle — gmail-mcp resolves by filename; the rotating
 * attachmentId is deliberately not used), and only on gmail_get_attachment.
 */
export function GmailAttachmentActions({ args }: { args?: Record<string, unknown> }) {
  const [projects, setProjects] = useState<{ id: string; name: string; emoji?: string | null }[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'added' | 'duplicate' | null>(null);

  const messageId = typeof args?.messageId === 'string' ? args.messageId : '';
  const filename = typeof args?.filename === 'string' ? args.filename.trim() : '';
  const label = typeof args?.label === 'string' ? args.label : undefined;
  if (!messageId || !filename) return null;

  const loadProjects = async () => {
    try {
      const { projectsApi } = await import('@/lib/api/crossmodel');
      const data = await projectsApi.list();
      // Editor+ only is enforced server-side; the picker lists owned folders
      // (shared-editor folders included — the backend re-checks access).
      const rows = [
        ...data.owned.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji })),
        ...data.shared.map((p: any) => ({ id: p.id, name: p.name, emoji: p.emoji })),
      ];
      setProjects(rows);
      if (rows.length && !projectId) setProjectId(rows[0].id);
    } catch {
      setProjects([]);
    }
  };

  const add = async () => {
    if (busy || !projectId) return;
    setBusy(true);
    setDone(null);
    try {
      const { filesApi } = await import('@/lib/api/crossmodel');
      const doc = await filesApi.addGmailAttachmentToProject(projectId, messageId, filename, label);
      setDone(doc.duplicate ? 'duplicate' : 'added');
      toast.success(doc.duplicate
        ? `"${doc.name}" is already in that folder's knowledge base`
        : `Added "${doc.name}" to the folder's knowledge base — ingestion runs in the background`);
    } catch (err: any) {
      const why = err?.response?.data?.error || err?.message || 'unknown error';
      toast.error(`Failed to add attachment: ${why}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 ml-4 flex flex-wrap items-center gap-1.5" data-gmail-attachment-actions={messageId}>
      <span className="text-[10.5px] text-muted-foreground/70">Add to project knowledge:</span>
      <select
        className="h-6 max-w-44 rounded border border-border/60 bg-background px-1.5 text-[11px] text-foreground/90"
        value={projectId}
        onFocus={() => { if (projects === null) void loadProjects(); }}
        onClick={() => { if (projects === null) void loadProjects(); }}
        onChange={(e) => setProjectId(e.target.value)}
        aria-label="Project to add the Gmail attachment to"
      >
        {projects === null && <option value="">Loading folders…</option>}
        {projects !== null && projects.length === 0 && <option value="">No folders</option>}
        {projects?.map((p) => (
          <option key={p.id} value={p.id}>{p.emoji ? `${p.emoji} ` : ''}{p.name}</option>
        ))}
      </select>
      <Button
        variant="ghost" size="sm"
        className="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground"
        disabled={busy || !projectId || (projects !== null && projects.length === 0)}
        onClick={() => void add()}
      >
        {busy ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <MailCheck className="mr-1 h-3 w-3" />}
        {done === 'duplicate' ? 'Already added' : done === 'added' ? 'Added' : 'Add'}
      </Button>
    </div>
  );
}

export function toolIcon(name: string) {
  if (name === 'run_command') return Terminal;
  if (name === 'write_file' || name === 'edit_file' || name === 'ast_rewrite') return FileEdit;
  if (name === 'grep' || name === 'glob' || name === 'ast_search' || name === 'search_engine' || name === 'search_memory' || name === 'web_pipe') return Search;
  if (name === 'spawn_subagent' || name === 'delegate' || name === 'delegate_parallel') return Users;
  if (name === 'update_plan') return ListChecks;
  if (name === 'verify') return CheckCheck;
  if (name === 'start_background_process') return Play;
  if (name === 'stop_process') return Square;
  if (name === 'read_process_output' || name === 'list_processes') return Activity;
  if (name.startsWith('github_')) return Github;
  if (name === 'gmail_search' || name === 'drive_search' || name === 'slack_search' || name === 'asana_search') return Search;
  return Wrench;
}

/** Plain-English one-liner for a tool call (owner directive 2026-07-24) —
 *  raw tool names never reach the UI; the useful detail (path/cmd/query) stays. */
export function toolSummary(name: string, args: any): string {
  if (name === 'update_plan') return `Plan · ${(args?.steps?.length ?? 0)} steps`;
  if (name === 'verify') return `Running checks${args?.only?.length ? ` · ${args.only.join(', ')}` : ''}`;
  if (name === 'delegate' || name === 'spawn_subagent') return `Asked a ${args?.role || 'helper'}${args?.title ? ` · ${args.title}` : ''}`;
  if (name === 'delegate_parallel') return `Asked ${(args?.tasks?.length ?? 0)} helpers in parallel`;
  // 2026-09-14 (owner: "is that why I always saw 'Checked saved notes' instead of
  // reading memory??"): search_memory IS the memory read — since the memory
  // unification it spans the project knowledge base, learnings, decisions and
  // the code index — so the label says what it does.
  if (name === 'search_memory') return `Searched project memory${args?.query ? ` · ${String(args.query).slice(0, 50)}` : ''}`;
  if (name === 'search_engine') return `Searched the web${args?.query ? ` · ${String(args.query).slice(0, 50)}` : ''}`;
  if (name === 'web_pipe') return `Researched online · ${String(args?.query || (Array.isArray(args?.urls) ? `${args.urls.length} pages` : '')).slice(0, 50)}`;
  if (name === 'scrape_as_markdown') return `Read a page${args?.url ? ` · ${String(args.url).slice(0, 50)}` : ''}`;
  if (name === 'scrape_batch') return Array.isArray(args?.urls) ? `Read ${args.urls.length} pages` : 'Read pages';
  if (name === 'browser_task') return 'Browsed a site';
  if (name === 'ask_user') return 'Asked you a question';
  if (name === 'run_command') return `Ran a command${args?.command ? ` · ${String(args.command).slice(0, 60)}` : ''}`;
  if (name === 'write_file') return `Created ${args?.path || 'a file'}`;
  if (name === 'edit_file') return `Edited ${args?.path || 'a file'}`;
  if (name === 'read_file') return `Read ${args?.path || 'a file'}`;
  if (name === 'grep') return `Searched code${args?.pattern ? ` · ${args.pattern}` : ''}`;
  if (name === 'ast_search') return `Searched code structure${args?.pattern ? ` · ${String(args.pattern).slice(0, 60)}` : ''}`;
  if (name === 'ast_rewrite') return `Rewrote code${args?.pattern ? ` · ${String(args.pattern).slice(0, 40)} → ${String(args.rewrite ?? '').slice(0, 40)}` : ''}`;
  if (name === 'glob') return `Found files${args?.pattern ? ` · ${args.pattern}` : ''}`;
  if (name === 'start_background_process') return `Started a background task${args?.name ? ` · ${args.name}` : ''}`;
  if (name === 'stop_process') return 'Stopped a background task';
  if (name === 'read_process_output') return 'Checked task output';
  if (name === 'list_processes') return 'Listed background tasks';
  if (name === 'gmail_search') return `Searched Gmail${args?.query ? ` · ${String(args.query).slice(0, 50)}` : ''}`;
  if (name === 'drive_search') return `Searched Drive${args?.query ? ` · ${String(args.query).slice(0, 50)}` : ''}`;
  if (name === 'slack_search') return `Searched Slack${args?.query ? ` · ${String(args.query).slice(0, 50)}` : ''}`;
  if (name === 'asana_search') return `Searched Asana${args?.query ? ` · ${String(args.query).slice(0, 50)}` : ''}`;
  if (name.startsWith('github_')) return `GitHub · ${name.slice(7).replace(/_/g, ' ')}`;
  // Fallback for anything unmapped: humanize (underscores → spaces), keep detail.
  const human = name.replace(/_/g, ' ');
  if (!args) return human;
  if (args.path) return `${human} · ${args.path}`;
  if (args.command) return `${human} · ${String(args.command).slice(0, 60)}`;
  if (args.handle) return `${human} · ${args.handle}`;
  if (args.pattern) return `${human} · ${args.pattern}`;
  if (args.query) return `${human} · ${String(args.query).slice(0, 50)}`;
  if (args.title) return `${human} · ${args.title}`;
  if (args.message) return `${human} · ${String(args.message).slice(0, 50)}`;
  return human;
}

const PLAN_MARK: Record<string, string> = { pending: '○', in_progress: '◐', completed: '●', blocked: '⊘' };
const PLAN_COLOR: Record<string, string> = {
  pending: 'text-muted-foreground', in_progress: 'text-ink-2', completed: 'text-success-accent', blocked: 'text-warn-ink',
};

const PLAN_STATUS_KEYS = ['pending', 'in_progress', 'completed', 'blocked'];

/**
 * The update_plan step shapes the backend validator accepts (coding/plan.service.ts validatePlanUpdate), normalised
 * for the card. PlanCard draws the RAW tool-call args, so a plain-string step or the status-keyed shorthand
 * {"in_progress": "<text>"} (ticket 17a0b383) rendered as a blank pending row and the done counter missed it.
 * A plain non-empty string → {text}; a text-less object whose keys are exactly ONE canonical status (case / spaces /
 * hyphens normalised, synonyms are not keys) with a non-empty string value, plus optionally a string "note" →
 * {text, status, note?}. Every other object passes through unchanged; a non-object becomes {} so a malformed call
 * never crashes the card.
 */
export function normalizePlanCardSteps(steps: unknown): any[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((s) => {
    if (typeof s === 'string') return s.trim() ? { text: s } : {};
    if (!s || typeof s !== 'object' || Array.isArray(s)) return {};
    const obj = s as Record<string, unknown>;
    if ('text' in obj) return obj;
    const keys = Object.keys(obj);
    const statusKeys = keys.filter(k => k !== 'note');
    if (statusKeys.length !== 1 || keys.length > 2) return obj;
    if ('note' in obj && typeof obj.note !== 'string') return obj;
    const status = statusKeys[0].toLowerCase().trim().replace(/[\s-]/g, '_');
    const value = obj[statusKeys[0]];
    if (!PLAN_STATUS_KEYS.includes(status) || typeof value !== 'string' || !value.trim()) return obj;
    return 'note' in obj ? { text: value, status, note: obj.note } : { text: value, status };
  });
}

/** A live checklist card for an update_plan tool call (the GOAL primitive). */
export function PlanCard({ args }: { args: any }) {
  const steps: any[] = normalizePlanCardSteps(args?.steps);
  const done = steps.filter(s => s.status === 'completed').length;
  return (
    <div className="rounded-lg border border-line/40 bg-hover/40 dark:bg-hover/10 my-1.5 px-2.5 py-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium mb-1">
        <ListChecks className="size-3.5 text-ink-2 shrink-0" />
        <span className="truncate flex-1">{args?.goal || 'Plan'}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground shrink-0">{done}/{steps.length}</span>
      </div>
      <ul className="space-y-0.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span className={cn('shrink-0', PLAN_COLOR[s.status] || 'text-muted-foreground')}>{PLAN_MARK[s.status] || '○'}</span>
            <span className={cn('[overflow-wrap:anywhere]', s.status === 'completed' && 'line-through text-muted-foreground')}>{s.text}{s.note ? <span className="text-muted-foreground"> — {s.note}</span> : null}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Colorizes unified-diff / +/- output (git-style green add, red remove). */
export function DiffText({ text }: { text: string }) {
  const lines = text.split('\n');
  const looksLikeDiff = lines.some(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  if (!looksLikeDiff) {
    return <pre className="text-[11px] leading-relaxed whitespace-pre-wrap break-words">{text}</pre>;
  }
  return (
    <pre className="text-[11px] leading-relaxed whitespace-pre-wrap break-words">
      {lines.map((l, i) => {
        const isMeta = /^(\+\+\+|---|@@|diff |index )/.test(l);
        const add = !isMeta && l.startsWith('+');
        const del = !isMeta && l.startsWith('-');
        return (
          <span key={i} className={cn(
            'block',
            isMeta && 'text-muted-foreground/70',
            add && 'text-success bg-success-accent/10',
            del && 'text-destructive bg-destructive/10',
          )}>{l || '​'}</span>
        );
      })}
    </pre>
  );
}

/** Ticking elapsed-since-mount for live "thinking" headers (SOTA polish
 *  2026-08-30); freezes at its last value once the run is no longer live. */
function useLiveElapsedMs(active?: boolean, sinceIso?: string): number {
  // Anchor on the part's own ts when the stream stamped one (audit
  // 2026-09-15): a mount-based clock restarted at 0s every time the block
  // remounted, disagreeing with the run-level timer beside it.
  const [startedAt] = useState(() => {
    const t = sinceIso ? Date.parse(sinceIso) : NaN;
    return Number.isFinite(t) && t <= Date.now() ? t : Date.now();
  });
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => tick(x => x + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return Date.now() - startedAt;
}

/** Live "thinking" — subtle, spaced, AUTO-COLLAPSED (owner directive 2026-07-24);
 *  expand to peek under the hood in small font. Streams as it arrives. Fades
 *  back once the run is done (2026-08-30). */
export function ReasoningBlock({ text, live, label, ts }: { text: string; live?: boolean; label?: string; ts?: string }) {
  const [open, setOpen] = useState(false);
  const elapsedMs = useLiveElapsedMs(live, ts);
  if (!text.trim()) return null;
  return (
    <div className={cn('my-1.5 border-l-2 border-border pl-3 transition-opacity', !live && 'opacity-75')}>
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-[11px] text-muted-foreground/80 hover:text-muted-foreground select-none">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className={cn(live && 'animate-pulse')}>{live ? 'Thinking…' : 'Thought process'}{label ? ` · ${label}` : ''}</span>
        {live && <span className="tabular-nums text-muted-foreground/70">{fmtElapsed(elapsedMs)}</span>}
      </button>
      {open && (
        <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground/90 whitespace-pre-wrap break-words">{text}</div>
      )}
    </div>
  );
}

/**
 * Multi-persona thinking, SOTA-style (owner report 2026-08-30): consecutive
 * reasoning parts (Digby + Fact-checker/Researcher/… stream concurrently)
 * collapse into ONE disclosure instead of a full-width row per persona.
 * While the run is live the header pulses and a two-line preview of the
 * freshest thought shows under it; expanding reveals per-persona sections.
 */
export function ThoughtGroup({ thoughts, live }: { thoughts: MessagePart[]; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const visible = thoughts.filter(t => ((t.text as string | undefined) || '').trim());
  const elapsedMs = useLiveElapsedMs(live, visible.find(t => t.ts)?.ts);
  if (!visible.length) return null;
  const labels = [...new Set(visible.map(t => t.label).filter(Boolean) as string[])];
  const freshest = visible[visible.length - 1];
  const preview = ((freshest.text as string | undefined) || '').trim().slice(-220);
  return (
    <div className={cn('my-1.5 border-l-2 border-border pl-3 transition-opacity', !live && 'opacity-75')}>
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-[11px] text-muted-foreground/80 hover:text-muted-foreground select-none">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Brain className="size-3" />
        <span className={cn(live && 'animate-pulse')}>
          {live ? 'Thinking…' : 'Thought process'}{labels.length ? ` · ${labels.join(', ')}` : ''}
        </span>
        {live && <span className="tabular-nums text-muted-foreground/70">{fmtElapsed(elapsedMs)}</span>}
      </button>
      {live && !open && preview && (
        <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/70 line-clamp-2 break-words">{preview}</div>
      )}
      {open && (
        <div className="mt-1 space-y-2">
          {visible.map((th, i) => (
            <div key={(th as any).uid ?? i}>
              {th.label && <div className="text-[12px] font-medium text-ink-3 select-none">{th.label}</div>}
              <div className="text-[12px] leading-relaxed text-muted-foreground/90 whitespace-pre-wrap break-words">{th.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Fully-styled markdown for the code transcript at its denser type scale.
 * (`prose` was inert — @tailwindcss/typography isn't loaded.)
 * `sizes` (plain-chat mode only) swaps in the user's chat text-size preference
 * (TEXT_SIZE_MAP) — coding transcripts keep the dense defaults.
 */
/**
 * Harness chrome (ticket 295068fa → owner ask 2026-09-14): the trailing
 * ```claims manifest, the "✓ Auto-verify passed (…)" line, the
 * "[HARNESS EVIDENCE GUARD] …" note and the "🔍 Harness claim / push-claim
 * verification" footers are harness plumbing, not answer prose — they used to
 * render as raw paragraphs + a JSON code block under every evidence-carrying
 * final. lib/harness-chrome.ts peels them off the tail (the claims chip's
 * trailing-only split is EXTENDED there — a fence UNDER later footers now
 * collapses too) and ONE collapsed <VerificationFooter/> renders them:
 * a chip summary line, full details behind the chevron (collapse, never
 * filter — verbatim, one click away).
 *
 * Harness-authored assistant CARDS route here too so every surface that
 * renders an assistant final (plain chat list AND code transcript — both
 * flow through this component) gets them: `[Owner inbox] …` notes
 * (metadata.origin 'owner-inbox' / the prefix) → <OwnerInboxCard/>; the
 * per-project supervisor's status row (origin 'project_status') →
 * <ProjectStatusCard/>. `meta` is optional — prefix detection needs none.
 */
export function CodeTranscriptMarkdown({ text, sizes, meta, localizeTimes, statusSuperseded }: {
  text: string;
  sizes?: TextSizeClasses;
  meta?: PlainMessageMeta;
  /** Show UTC clocks inside the text in the viewer's local time (owner 2026-09-14:
   *  supervisor updates "in the users local timezone"). Callers pass true for
   *  supervisor chats; machine-stamped rows (owner briefings, machine origins)
   *  localize regardless. Plain human conversation is never rewritten. */
  localizeTimes?: boolean;
  /** Owner 2026-09-29: a NEWER project status card exists in this chat — this
   *  one renders as a single expandable line. */
  statusSuperseded?: boolean;
}) {
  const minimalViewNow = useMinimalView();
  const card = classifyAssistantCard({ role: 'assistant', content: text, metadata: meta });
  if (card === 'owner-inbox') return <OwnerInboxCard content={text} />;
  if (card === 'project-status' || card === 'session-status') {
    // mapPlainMessages (plain) and bridgeCodingMeta (coding) pass the whole
    // metadata object through, so the contract's `status` / `generatedAt`
    // ride plainMeta. The per-SESSION card (owner ask 2026-09-15) is the same
    // component with session facts and a "Session status" label.
    // 2026-09-24: the no-change stub's quiet facts (unchanged / quietSince /
    // quietChecks) ride the same row metadata — the card renders its compact
    // variant from them instead of re-asserting the copied-forward brief.
    const m = meta as (PlainMessageMeta & { status?: unknown; brief?: unknown; update?: unknown; generatedAt?: string; unchanged?: boolean; quietSince?: string; quietChecks?: number }) | undefined;
    return (
      <ProjectStatusCard
        content={text} status={m?.status} brief={m?.brief} update={m?.update} generatedAt={m?.generatedAt}
        unchanged={m?.unchanged} quietSince={m?.quietSince} quietChecks={m?.quietChecks}
        superseded={card === 'project-status' && !!statusSuperseded}
        variant={card === 'session-status' ? 'session' : 'project'}
      />
    );
  }
  const stamp = meta as (PlainMessageMeta & { kind?: string; origin?: string }) | undefined;
  // Minimal view (2026-10-16): harness footers never render for a user (the server already strips stored ones;
  // this covers text still streaming in).
  const minimal = minimalViewNow;
  const machineAuthored = !!localizeTimes || stamp?.kind === 'owner_briefing' || isMachineStampOrigin(stamp?.origin);
  const { body: rawBody, chrome, hasChrome } = splitHarnessChrome(text);
  // Ticket 7345b333: rows persisted before the source-side fix shipped still
  // carry raw `<tool_call><function=…><parameter=…>` markup. Strip it at render
  // so the owner's history reads correctly without waiting for a backfill.
  // Display transform only — stored content is untouched — and fenced blocks
  // are preserved, so a run that QUOTES the markup still illustrates it.
  const markupFree = stripToolMarkupForRender(rawBody);
  const body = machineAuthored ? localizeUtcTimes(markupFree) : markupFree;
  return (
    <>
      {body && (
        <MarkdownContent
          textSizeCls={sizes?.p ?? 'text-sm leading-6'}
          h1Cls={sizes?.h1 ?? 'text-lg'} h2Cls={sizes?.h2 ?? 'text-base'} h3Cls={sizes?.h3 ?? 'text-sm'} h4Cls={sizes?.h4 ?? 'text-sm'}
          thCls={sizes?.th ?? 'text-xs'} tdCls={sizes?.td ?? 'text-xs'}>
          {body}
        </MarkdownContent>
      )}
      {hasChrome && !minimal && <VerificationFooter chrome={chrome} />}
    </>
  );
}

/**
 * Tool-activity accordion (ticket 295068fa): the in-run continuation of the
 * machine-turn accordion precedent — a run of ≥4 consecutive tool parts
 * collapses into ONE quiet pill with a plain-English summary ("12 actions ·
 * 5 web searches · 3 memory searches · 4 pages read"); expanding renders the
 * original ToolCards verbatim (collapse, never filter).
 *
 * LIVE fold (owner 2026-09-15, plain chats): the run at the parts tail folds
 * too — the header carries a spinner, names the seat(s) working (Double
 * Checker / Digby) and, while collapsed, the CURRENT action stays visible
 * beneath it so the user still follows along. Coding sessions keep their
 * expanded live edge (lib/tool-activity-grouping foldTail).
 */
function ToolActivityGroup({ item, nodes, parts }: { item: ToolActivityItem; nodes: React.ReactNode[]; parts: MessagePart[] }) {
  const [open, setOpen] = useState(false);
  const runParts = item.indices.map(i => parts[i]).filter(Boolean);
  const summary = toolActivityLabel(item.names, runParts);
  // Attribution: a run produced by one non-lead seat is that seat's work;
  // several seats interleaving read "Digby + Double Checker".
  const who = item.labels.length ? item.labels.join(' + ') : '';
  const live = item.live === true;
  return (
    <div className="my-0.5 text-xs" data-tool-activity={live ? 'live' : 'done'}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="group w-full flex items-center gap-1.5 py-0.5 text-left cursor-pointer select-none">
        {live
          ? <Loader2 className="size-3 text-ink-3 animate-spin shrink-0" aria-hidden />
          : <Wrench className="size-3 text-muted-foreground shrink-0" aria-hidden />}
        <span className="text-[11px] text-muted-foreground/90 truncate flex-1">
          {who ? <span className="text-foreground/70">{who} · </span> : null}
          {live ? 'Working' : 'Tool activity'} · {summary}
        </span>
        {open
          ? <ChevronDown className="size-3 text-muted-foreground/70 shrink-0" />
          : <ChevronRight className="size-3 text-muted-foreground/60 opacity-60 md:opacity-0 md:group-hover:opacity-100 shrink-0" />}
      </button>
      {/* Collapsed + live: the newest action stays visible — the follow-along
          signal without the wall of rows. */}
      {!open && live && nodes.length > 0 && (
        <div className="ml-4 border-l border-border/40 pl-2 opacity-80">{nodes[nodes.length - 1]}</div>
      )}
      {open && (
        <div className="ml-4 mt-0.5 mb-1 border-l border-border/60 pl-2">
          {nodes}
        </div>
      )}
    </div>
  );
}

/** Compact, borderless tool row (Claude-Code style): icon · summary · expandable detail. */
export function ToolCard({ part }: { part: MessagePart }) {
  const [open, setOpen] = useState(false);
  // name is optional on MessagePart (text/reasoning/image parts have none) —
  // fall back to a generic label rather than passing undefined through.
  const name = part.name ?? 'tool';
  const Icon = toolIcon(name);
  const hasArgs = part.args && Object.keys(part.args).length > 0;
  const hasResult = part.result !== undefined && part.result !== '';
  const expandable = hasArgs || hasResult;
  // Seat attribution (owner 2026-09-15): plain chats stamp the seat that
  // fired the tool on the part — a non-lead seat's row says so, so the Double
  // Checker's research is never mistaken for Digby's.
  const seat = typeof (part as any).label === 'string' && (part as any).label.trim() && (part as any).label.trim() !== 'Digby'
    ? String((part as any).label).trim()
    : '';
  return (
    <div className="my-0.5 text-xs">
      <button
        onClick={() => expandable && setOpen(o => !o)}
        className={cn('group w-full flex items-center gap-1.5 py-0.5 text-left', expandable ? 'cursor-pointer' : 'cursor-default')}>
        <Icon className="size-3 text-muted-foreground shrink-0" />
        <span className="text-[11px] text-muted-foreground/90 truncate flex-1">
          {seat ? <span className="text-foreground/60">{seat} · </span> : null}
          {toolSummary(name, part.args)}
        </span>
        {expandable && (open
          ? <ChevronDown className="size-3 text-muted-foreground/70 shrink-0" />
          : <ChevronRight className="size-3 text-muted-foreground/60 opacity-60 md:opacity-0 md:group-hover:opacity-100 shrink-0" />)}
      </button>
      {open && expandable && (
        <div className="ml-4 mt-0.5 mb-1 space-y-1 border-l border-border/60 pl-2">
          {hasArgs && (
            <pre className="text-[10.5px] leading-relaxed text-muted-foreground/80 whitespace-pre-wrap break-words overflow-x-auto">{JSON.stringify(part.args, null, 2)}</pre>
          )}
          {hasResult && (
            <div className="max-h-72 overflow-y-auto"><DiffText text={String(part.result)} /></div>
          )}
        </div>
      )}
      {/* Gmail→KB (ticket 99145890): the "Add to project knowledge" row under a
          gmail_get_attachment call — only when the call carries messageId +
          filename (the dedup key + the stable resolution handle). */}
      {name === 'gmail_get_attachment' && <GmailAttachmentActions args={part.args} />}
    </div>
  );
}

/**
 * Prose group (ticket 0b4575dd, owner report 2026-08-28): interleaved-thinking
 * models (kimi-k3) persist one continuous answer as many small text fragments
 * separated by full-width "Thought process" rows. A group renders the run as
 * ONE flowing markdown block (byte-lossless join of the text channel — see
 * lib/prose-grouping.ts) with the interleaved thoughts behind a compact chip,
 * plus a raw-order toggle that flips back to the legacy fragmented view.
 * Display-layer only: nothing about what is stored or sent changes.
 */
/**
 * Per-block hover timestamp (owner report 2026-08-31): a run persists as ONE
 * assistant message, so the message-level corner stamp alone made a long
 * run's text blocks look simultaneous — each block now shows its own part
 * `ts` (backend stamps at push time, the live stream at client ingest;
 * absent on pre-2026-08 persisted rows → no stamp). Mirrors the message-row
 * pattern: desktop = hover-revealed corner stamp, mobile = always-visible
 * muted pill (backgrounded so it stays readable over the block's text).
 */
/**
 * Whether per-part stamps render at all (owner 2026-09-17 "all time stamps
 * should show in the same place which is underneath … two time stamps is fine
 * when there is an outer long-running loop but you can't read the second
 * one"): AssistantParts provides TRUE only for multi-part messages (a loop
 * with several prose blocks / tool rounds), where a per-block time carries
 * information; a single-answer message relies on the ONE message-level stamp
 * underneath it.
 */
export const PartTimesContext = createContext<boolean>(true);

/**
 * Per-part stamp: an IN-FLOW right-aligned caption line above the block —
 * never an absolutely-positioned overlay on the prose (the 2026-09-17
 * screenshot had the corner stamp printed over the sentence end). Desktop
 * reveals it on hover of the block, mobile always shows the muted pill.
 */
export function PartTime({ ts }: { ts?: string }) {
  const show = useContext(PartTimesContext);
  const label = formatMessageTime(ts);
  if (!label || !show) return null;
  return (
    <div className="flex justify-end h-3 -mb-0.5 pointer-events-none select-none" aria-hidden>
      <span className="hidden md:block text-[10px] leading-3 text-muted-foreground/70 whitespace-nowrap tabular-nums opacity-0 group-hover/part:opacity-100 transition-opacity">{label}</span>
      <span className="md:hidden text-[10px] leading-3 text-muted-foreground/70 whitespace-nowrap tabular-nums rounded bg-background/80 px-1">{label}</span>
    </div>
  );
}

function ProseGroup({ group, sizes, hideThinking }: { group: ProseGroupItem; sizes?: TextSizeClasses; hideThinking?: boolean }) {
  const [showThoughts, setShowThoughts] = useState(false);
  const [raw, setRaw] = useState(false);
  if (raw) {
    return (
      <div className="my-2 first:mt-0 last:mb-0">
        <button onClick={() => setRaw(false)}
          className="mb-1 inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground/80 hover:text-muted-foreground select-none">
          <ChevronDown className="size-3" /> Joined view
        </button>
        <AssistantParts parts={group.raw} sizes={sizes} hideThinking={hideThinking} disableGrouping />
      </div>
    );
  }
  // The group's stamp = its first text fragment's ts (the raw-order expansion
  // renders the fragments individually, each with its own PartTime).
  const groupTs = group.texts.find(t => t.ts)?.ts;
  return (
    <div className="group/part relative my-2 first:mt-0 last:mb-0">
      <PartTime ts={groupTs} />
      <CodeTranscriptMarkdown text={proseGroupText(group)} sizes={sizes} />
      {!hideThinking && group.thoughts.length > 0 && (
        <div className="mt-0.5 flex items-center gap-1.5">
          <button onClick={() => setShowThoughts(o => !o)}
            className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground/80 hover:text-muted-foreground hover:bg-muted/50 select-none">
            <Brain className="size-3" />
            {group.thoughts.length === 1 ? '1 thought' : `${group.thoughts.length} thoughts`}
            {showThoughts ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
          <button onClick={() => setRaw(true)}
            className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground/70 hover:text-muted-foreground select-none"
            title="Show the text fragments and thought rows in arrival order">
            raw order
          </button>
        </div>
      )}
      {showThoughts && !hideThinking && group.thoughts.length > 0 && (
        <div className="mt-1 space-y-1.5 border-l-2 border-border pl-3">
          {group.thoughts.map((th, i) => (
            <div key={(th as any).uid ?? i} className="text-[12px] leading-relaxed text-muted-foreground/90 whitespace-pre-wrap break-words">
              <span className="text-muted-foreground/70 select-none">Thought {i + 1} · </span>{th.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Word count for the struck-draft disclosure label. */
function countWords(text: string): number {
  return (text.trim().match(/\S+/g) || []).length;
}

/**
 * Harness guard marker (2026-09-08): the agent loop's own notice that the
 * draft before it was discarded (zero-tool gate) or rejected back to the model
 * (evidence guard). Amber callout, never markdown-rendered prose.
 */
export function GuardMarkerBlock({ text, ts }: { text: string; ts?: string }) {
  return (
    <div className="group/part relative my-2 first:mt-0 last:mb-0" data-guard-marker>
      <PartTime ts={ts} />
      <div role="note" className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn-ink">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="break-words">{text.replace(/^⚠︎\s*/, '')}</span>
      </div>
    </div>
  );
}

/**
 * A draft the evidence guard rejected before submission: collapsed by default
 * behind a "Rejected draft — not submitted" disclosure so nobody reads a
 * refused fabrication as the run's answer; expandable for audit.
 */
export function StruckDraftBlock({ text, ts, sizes }: { text: string; ts?: string; sizes?: TextSizeClasses }) {
  const [open, setOpen] = useState(false);
  const words = countWords(text);
  return (
    <div className="group/part relative my-2 first:mt-0 last:mb-0" data-struck-draft>
      <PartTime ts={ts} />
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <XCircle className="size-3 text-warn-ink" aria-hidden />
        <span>Rejected draft — not submitted{words ? ` (${words} ${words === 1 ? 'word' : 'words'})` : ''}</span>
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-warn/40 pl-3 opacity-70">
          <CodeTranscriptMarkdown text={text} sizes={sizes} />
        </div>
      )}
    </div>
  );
}

const ACTIVITY_ICONS: Record<ActivityKind, typeof Terminal> = {
  terminal: Terminal, edit: FileEdit, read: Search, web: Globe, browser: Globe, computer: Activity, github: Github,
  message: Send, routine: RotateCcw, session: Users, memory: Brain, image: Zap, email: Send, calendar: RotateCcw,
  drive: FileEdit, app: Zap, other: Wrench,
};

/**
 * Minimal view activity row (2026-10-16, lib/minimal-activity.ts): a note row (routine / message) is a centred grey
 * line; any other row renders as a one-row MinimalActivityLine (AssistantParts merges runs before they get here).
 */
function MinimalActivity({ row }: { row: ActivityRow }) {
  if (row.note) {
    // Grok-style background line: "Created routine ⟳ Counsel email watch" — centred, grey, no box.
    const Icon = ACTIVITY_ICONS[row.activity] || Wrench;
    const label = row.labels.length === 1 && row.summary.endsWith(row.labels[0]) ? row.labels[0] : '';
    const verb = label ? row.summary.slice(0, row.summary.length - label.length).trim() : row.summary;
    return (
      <div data-minimal-note data-minimal-activity={row.activity} className="my-2 flex items-center justify-center gap-1.5 text-[12.5px] text-ink-3">
        <span>{verb}</span>
        {label && <><Icon className="size-3.5 shrink-0" /><span className="truncate text-ink-2">{label}</span></>}
      </div>
    );
  }
  return <MinimalActivityLine line={{ kind: 'activityLine', text: row.summary, rows: [row], start: row.start }} />;
}

/**
 * Every tool step between two pieces of prose as ONE small light-grey line ("Read 4 emails · Checked memory")
 * — no box, no icon tile (owner 2026-10-16: "much uglier … the small little text in light gray instead of these
 * big boxes … it was supposed to appear less"). A click opens the short labels the server kept, still grey.
 */
function MinimalActivityLine({ line }: { line: ActivityLine }) {
  const [open, setOpen] = useState(false);
  const canOpen = line.rows.some(r => r.labels.length > 0);
  return (
    <div className="my-1 text-[12.5px] leading-5 text-ink-3" data-minimal-activity={line.rows.map(r => r.activity).join(' ')}>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => setOpen(o => !o)}
        className="group inline-flex max-w-full items-center gap-1 text-left hover:text-ink-2 disabled:cursor-default disabled:hover:text-ink-3"
        aria-expanded={canOpen ? open : undefined}
      >
        <span className="truncate">{line.text}</span>
        {canOpen && (open ? <ChevronDown className="size-3 shrink-0 opacity-70" /> : <ChevronRight className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-70" />)}
      </button>
      {open && canOpen && (
        <ul className="mt-0.5 space-y-0.5 border-l border-line pl-2.5">
          {line.rows.flatMap(r => r.labels.map((l, i) => (
            <li key={`${r.start}-${i}`} className="truncate text-[12px] text-ink-3">{l}</li>
          )))}
        </ul>
      )}
    </div>
  );
}

/**
 * Renders an assistant message's ordered parts IN ARRIVAL ORDER
 * (text · reasoning · tool cards · subagents) so live runs read chronologically.
 * Runs of text/reasoning with ≥2 prose fragments collapse into ProseGroups
 * (ticket 0b4575dd); consecutive reasoning subruns with ≥2 thoughts collapse
 * into ONE ThoughtGroup disclosure (owner report 2026-08-30); `disableGrouping`
 * renders every part individually (raw order expansion). `hideThinking` drops
 * reasoning rows/chips entirely.
 */
export const AssistantParts = memo(function AssistantParts({ parts, sizes, hideThinking: hideThinkingProp, disableGrouping, foldTail, quietLiveTail }: { parts: MessagePart[]; sizes?: TextSizeClasses; hideThinking?: boolean; disableGrouping?: boolean; /** Plain chats (owner 2026-09-15): fold the LIVE tool run at the parts tail too — see lib/tool-activity-grouping. */ foldTail?: boolean; /** Plain live turn (owner 2026-10-07, "a lot going on"): render NOTHING for the tool run at the parts tail — the Thinking block / status line under the parts already names the current step, and the full run shows on the settled row. */ quietLiveTail?: boolean }) {
  // Minimal view (2026-10-16, lib/view-mode.ts): answers, images, task cards and one-line activity rows only.
  const minimal = useMinimalView();
  // Thinking stays hidden by default (owner 2026-10-04, lib/reasoning-visibility.ts) — reasoning parts already in a
  // saved history never render; NEXT_PUBLIC_HIDE_REASONING_DISABLED=1 restores them.
  const hideThinking = hideThinkingProp || !reasoningVisible();
  const rendered: React.ReactNode[] = [];
  // Call↔result pairing (owner 2026-09-15, Level 2): the Double Checker's
  // rows interleave with Digby's on one stream, so "the next part is my
  // result" (the old adjacency merge) rarely held — a call rendered as a
  // card AND its late result rendered as a second card. Each result now
  // binds to the nearest earlier unpaired call with the same name (and seat,
  // when both are labelled); paired results render nothing of their own.
  const pairing = pairToolActions(parts);
  const renderOne = (i: number): { node: React.ReactNode; consumed: number } => {
    const p = parts[i];
    // Stable identity: live parts carry a `uid` stamped at ingest so keys
    // survive the MAX_LIVE_PARTS front-slice (index keys re-keyed EVERY
    // element on every event past the cap — whole-transcript churn) and the
    // tool_call→result merge below (key must not flip when the result lands,
    // or the card remounts and snaps closed). Persisted parts (no uid) can
    // safely fall back to index — their array never shifts.
    const key = (p as any).uid ?? `i${i}`;
    if (p.type === 'text') {
      // Harness guard marker / struck draft (2026-09-08): the loop's own
      // "discarded" / "rejected back" notice renders as a callout, and the
      // rejected candidate before it collapses under "Rejected draft — not
      // submitted" — a viewer must never read a refused fabrication as the
      // run's ordinary prose (owner transcript, session a8976e11 firing-87).
      if (p.marker === 'guard') return { node: <GuardMarkerBlock key={key} text={p.text || ''} ts={p.ts} />, consumed: 0 };
      if (p.struck) return { node: <StruckDraftBlock key={key} text={p.text || ''} ts={p.ts} sizes={sizes} />, consumed: 0 };
      if ((p.text || '').trim()) {
        const partText = p.text || '';
        // 295068fa: a steer note ("↳ steering: …") is MACHINE chrome, not
        // agent prose — render it as a quiet one-line note instead of a
        // full-width prose block so long runs stay scannable.
        if (partText.trimStart().startsWith('↳ steering:')) {
          return {
            node: (
              <div key={key} className="group/part relative my-1 flex items-start gap-1.5 text-[11px] italic text-muted-foreground/80">
                <CornerDownRight className="size-3 mt-0.5 shrink-0" />
                <span className="break-words whitespace-pre-wrap flex-1">{partText}</span>
              </div>
            ),
            consumed: 0,
          };
        }
        return { node: <div key={key} className="group/part relative my-2 first:mt-0 last:mb-0"><PartTime ts={p.ts} /><CodeTranscriptMarkdown text={partText} sizes={sizes} /></div>, consumed: 0 };
      }
      return { node: null, consumed: 0 };
    }
    if (p.type === 'reasoning') {
      if (hideThinking) return { node: null, consumed: 0 };
      return { node: <ReasoningBlock key={key} text={p.text || ''} live={i === parts.length - 1} label={p.label} ts={p.ts} />, consumed: 0 };
    }
    if (p.type === 'tool_call') {
      const ri = pairing.resultFor.get(i);
      const merged = ri !== undefined ? { ...p, result: parts[ri].result } : p;
      if (p.name === 'update_plan') return { node: <PlanCard key={key} args={p.args} />, consumed: 0 };
      return { node: <ToolCard key={key} part={merged} />, consumed: 0 };
    }
    if (p.type === 'tool_result') {
      // Paired above — its call's card already carries the result.
      if (pairing.pairedResults.has(i)) return { node: null, consumed: 0 };
      return { node: <ToolCard key={key} part={p} />, consumed: 0 };
    }
    if (p.type === 'subagent') {
      return {
        node: (
          <div key={key} className="my-1 border-l border-line pl-2.5 text-xs">
            <div className="flex items-center gap-1.5 text-muted-foreground"><Users className="size-3 text-ink-3" /><span className="font-medium text-foreground/80">{p.title}</span></div>
            {p.summary && <div className="mt-0.5 text-muted-foreground/80 line-clamp-3 break-words">{p.summary}</div>}
          </div>
        ),
        consumed: 0,
      };
    }
    if (p.type === 'image' && (p.data || p.url) && p.mediaType) {
      // Click-to-expand (c6e8edda follow-up): the shared ExpandableDataImage
      // keeps the exact thumbnail classes and opens the ImageLightbox with the
      // image on click. `url` (lazy server-stripped transcript parts) wins;
      // `data` covers live-streamed/echo parts.
      // Screenshots in the chat (2026-09-23): a browser_task / computer_task
      // final frame carries `source` — render it as a framed figure with its
      // caption ("Final screen · Your Mac · Chrome") so the picture reads as
      // evidence of what the agent saw, not a stray attachment.
      // Generated images (2026-09-24): a generate_image result takes the same
      // framed-figure path — data-image-source="generated" (not a screenshot),
      // no bg-white behind transparent PNGs, caption fallback "Generated
      // image", and a Download / Open action row when the part carries the
      // GeneratedFile id. The live SSE event carries base64 `data` (instant,
      // no fetch) plus the lazy `url` the persisted part keeps; screenshots
      // keep the url-first rule (their lazy url IS the stripped bytes).
      if (p.source === 'browser' || p.source === 'computer' || p.source === 'generated') {
        const generated = p.source === 'generated';
        const dataSrc = p.data ? `data:${p.mediaType};base64,${p.data}` : undefined;
        const src = generated ? (dataSrc || p.url || '') : (p.url || dataSrc || '');
        const caption = p.name || (generated ? 'Generated image' : p.source === 'computer' ? 'Final screen · Your Mac' : 'Final page');
        return {
          node: (
            <figure
              key={key}
              className="my-2 inline-block max-w-full"
              data-screenshot-source={generated ? undefined : p.source}
              data-image-source={generated ? 'generated' : undefined}
            >
              <ExpandableDataImage src={src} alt={generated ? caption : (p.name || 'screenshot')} className={cn('max-h-72 max-w-full rounded-lg border border-border object-contain', !generated && 'bg-white')} />
              <figcaption className="mt-1 text-[10px] text-muted-foreground/80">{caption}</figcaption>
              {generated && p.fileId && <GeneratedImageActions part={p} />}
            </figure>
          ),
          consumed: 0,
        };
      }
      return {
        node: <ExpandableDataImage key={key} src={p.url || `data:${p.mediaType};base64,${p.data}`} alt={p.name || 'attached image'} className="my-1.5 max-h-48 max-w-full rounded-lg object-contain" />,
        consumed: 0,
      };
    }
    // Inline task card (cohesive chat, 2026-09-28): the harness's task
    // lifecycle as ONE card, in arrival order beside the prose — live parts and
    // the persisted row render identically (lib/task-card.ts). A malformed
    // payload renders nothing.
    if (p.type === 'task') {
      const task = taskOfPart(p);
      return { node: task ? <TaskCard key={key} task={task} /> : null, consumed: 0 };
    }
    return { node: null, consumed: 0 };
  };

  if (minimal) {
    for (const item of groupMinimalLines(buildMinimalItems(parts))) {
      if (item.kind === 'activityLine') { rendered.push(<MinimalActivityLine key={`l${item.start}`} line={item} />); continue; }
      if (item.kind === 'activity') { rendered.push(<MinimalActivity key={`a${item.start}`} row={item} />); continue; }
      const { node } = renderOne(item.index);
      if (node) rendered.push(node);
    }
    return <PartTimesContext.Provider value={false}><div className="space-y-1.5">{rendered}</div></PartTimesContext.Provider>;
  }
  if (disableGrouping) {
    for (let i = 0; i < parts.length; i++) {
      const { node, consumed } = renderOne(i);
      if (node) rendered.push(node);
      i += consumed;
    }
    return <div className="space-y-0.5">{rendered}</div>;
  }
  // 295068fa: completed tool-activity runs (≥4 consecutive tool parts) fold
  // into ONE collapsed pill; the run at the parts tail (the live edge the
  // user is following) stays expanded in coding sessions — see
  // lib/tool-activity-grouping. Paired results render null (see `pairing`).
  const renderToolRun = (indices: number[]): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    for (const idx of indices) {
      const { node } = renderOne(idx);
      if (node) nodes.push(node);
    }
    return nodes;
  };
  // Quiet live tail: index of the first part of the trailing tool run.
  let tailFrom = parts.length;
  if (quietLiveTail) {
    while (tailFrom > 0) {
      const p = parts[tailFrom - 1];
      if ((p.type === 'tool_call' || p.type === 'tool_result') && p.name !== 'update_plan') tailFrom--;
      else break;
    }
  }
  for (const item of groupToolActivityItems(groupProseParts(parts), parts, { foldTail })) {
    if (item.kind === 'toolActivity') {
      if (quietLiveTail && item.live) continue;
      rendered.push(<ToolActivityGroup key={item.key} item={item} nodes={renderToolRun(item.indices)} parts={parts} />);
      continue;
    }
    if (item.kind === 'prose') {
      rendered.push(<ProseGroup key={item.key} group={item} sizes={sizes} hideThinking={hideThinking} />);
      continue;
    }
    if (item.kind === 'thoughts') {
      if (hideThinking) continue;
      rendered.push(<ThoughtGroup key={item.key} thoughts={item.thoughts} live={item.endIndex === parts.length - 1} />);
      continue;
    }
    if (quietLiveTail && item.index >= tailFrom) continue;
    const { node } = renderOne(item.index);
    if (node) rendered.push(node);
  }
  // Per-part stamps only where a message has several blocks (a loop): a
  // single-answer message keeps its ONE stamp underneath (see PartTime).
  const multiPart = parts.filter((p) => (p.type === 'text' && (p.text || '').trim() && !(p as any).struck && (p as any).marker !== 'guard') || p.type === 'tool_call').length > 1;
  return <PartTimesContext.Provider value={multiPart}><div className="space-y-0.5">{rendered}</div></PartTimesContext.Provider>;
});

// ── Plain-chat transcript extras (One-Session Platform P2 increment 2) ────────
// Ported from page.tsx so the unified CodeSessionView renders the legacy chat
// enrichments: the email confirm card ([SEND_EMAIL] blocks survive
// stripForStorage), Sources pills, Suggested-next chips, and the admin
// More-info panel. C3 (ticket 71b1fec6) DELETED the legacy view — these are
// now the CANONICAL copies (the page.tsx twins are gone; `AgentSteps` retired
// here with it — AssistantParts is the one surviving work-trail renderer,
// design D3).

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}

/** Pull a named attribute out of a SEND_EMAIL tag's attribute string, tolerant
 *  of how the model formats quotes (port of page.tsx's extractEmailAttr). */
export function extractEmailAttr(attrs: string, name: string): string {
  const quoted = attrs.match(new RegExp(`${name}\\s*=\\s*['"“‘]([\\s\\S]*?)['"”’]`, 'i'));
  if (quoted) return quoted[1].trim();
  const unquoted = attrs.match(new RegExp(`${name}\\s*=\\s*([^\\s\\]'"“‘]+)`, 'i'));
  if (unquoted) return unquoted[1].trim();
  return '';
}

/**
 * A SEND_EMAIL opener tag's attribute string, QUOTE-AWARE and `[`-BOUNDED
 * (ticket 8d7d07b0): a quoted value may itself contain `]` — the live
 * specimen's `to="[recipient — see my note below]"`, or a bracketed subject
 * like `subject="Re: [Action required]"` (quoted spans are consumed whole,
 * `]` included). The quote-blind `([^\]]*)` scan truncated the tag at the
 * first `]` inside a value, so a perfectly valid draft lost its recipient,
 * failed to parse as a card, and — with the raw-return bug — rendered raw
 * markup instead. A BARE `[` is not legal inside a tag (review D3: an
 * unbounded scan swallowed prose up to a later `]`), so a tag containing one
 * fails the scan and the broken-opener rule below decides what is cut.
 */
// Ticket 0febb5f1 F2: a quote OPENS a value span only as part of an `=`-assignment
// (`to="x"`, `subject='Re: …'`). The pre-fix alternation matched quoted spans
// ANYWHERE, so the apostrophe of an UNQUOTED value (`subject=Bob's note`) paired
// with a later apostrophe in the prose, the scan consumed the real `]` AND the
// body up to a still-later apostrophe/bracket, the block parse died and the
// closer was eaten as tag text — the card vanished and the body with it. Now a
// quote in any other position STOPS the quote-aware scan: the shape is not a
// card (the block parser stays strict, exactly like every other malformed-tag
// shape — D3, N1…), and in emailDisplayCuts the linear scanEmailTagEnd
// tokenizer locates the real tag end and cuts ONLY the tag, so the body
// survives as prose — the documented no-card contract (a block that yields no
// card keeps its BODY; it is content, not markup).
//
// Linearity: a quoted span may only START at an `=`, and a plain char can
// never begin one, so backtracking can never re-split a consumed quoted span;
// dead-end branches (e.g. `= ` before a quote, where two units match the same
// index) die within one unit. Adversarial 16k-unit chains (`='x'='x'…`, quote
// floods, space-then-quote runs) all scan in ~1 ms — pinned by a test.
// NOTE: TAG_ATTRS contains ONLY non-capturing groups, so the regexes that wrap
// it as `(${TAG_ATTRS})` keep seeing the attrs in group 1.
// Each quoted span is capped at 4096 chars (= MAX_EMAIL_TAG, round-2 finding
// 2): an UNTERMINATED quote otherwise scans to end-of-text once per opener
// position — measured 3.6 s per parse pass on a 16k-opener adversarial
// message (the old pattern was already quadratic here at ~1.3 s; this rewrite
// must not make it worse, and with the cap the whole family is bounded at
// O(openers x 4096)). A quoted value longer than 4096 chars yields no card
// and its opener takes the broken-opener cut — bounded at the next closer
// token when one exists, so the tail after the block survives (main, whose
// card parse was unbounded, still rendered a card for such a value; the
// accepted cliff is documented in docs/MIGRATION_DISPLAY_AUDIT.md).
const TAG_ATTRS =
  /(?:=\s*(?:'[^']{0,4096}'|"[^"]{0,4096}"|“[^”]{0,4096}”|‘[^’]{0,4096}’)|=[^'"”’“‘\]\[]|=(?=\])|[^'="”’“‘\]\[])*/.source;

interface EmailBlock {
  /** span of the whole block in the source text */
  start: number;
  end: number;
  /** span of the opener TAG only ([SEND_EMAIL …]) — body excluded */
  openEnd: number;
  /** span of the closer token only ([/SEND_EMAIL]) */
  closeStart: number;
  attrs: string;
  body: string;
}

/** Every complete [SEND_EMAIL …]…[/SEND_EMAIL] block, quote-aware tags.
 *  A MARKDOWN LINK whose label is the marker text (`[send_email docs](…)` —
 *  an opener-shaped span with NO `=` and a `(` right after it) is not an
 *  opener: skipping it stops the non-greedy pairing from swallowing a real
 *  block further down (round-3 review D2 residual: a link label followed by
 *  a real draft used to eat the draft's opener as its body). */
function completeEmailBlocks(text: string): EmailBlock[] {
  const openerRe = new RegExp(`\\[SEND_EMAIL\\b(${TAG_ATTRS})\\]`, 'gi');
  const openers: Array<{ start: number; openEnd: number; attrs: string }> = [];
  let om: RegExpExecArray | null;
  while ((om = openerRe.exec(text))) {
    const attrs = om[1] || '';
    if (!attrs.includes('=') && text[om.index + om[0].length] === '(') continue; // link label
    openers.push({ start: om.index, openEnd: om.index + om[0].length, attrs });
  }
  const closer = '[/SEND_EMAIL]';
  const lower = text.toLowerCase();
  const out: EmailBlock[] = [];
  let cursor = 0;
  for (const op of openers) {
    if (op.start < cursor) continue; // consumed by an earlier block's body
    // Round-4 B1: case-insensitive closer lookup — round 2's block regex was
    // 'gi', and every other boundary here (openers, closer-token cuts, the
    // stripForStorage/stripLiveTags live strips) is case-insensitive. A
    // lowercase [/send_email] used to silently drop the card (body rendered
    // as prose, no raw marker, nothing fired) while live stripLiveTags hid it.
    const closeStart = lower.indexOf(closer.toLowerCase(), op.openEnd);
    if (closeStart < 0) break; // openers are ordered: no closer after this one ⇒ none after later ones
    const end = closeStart + text.slice(closeStart, closeStart + closer.length).length;
    out.push({
      start: op.start,
      openEnd: op.openEnd,
      closeStart,
      end,
      attrs: op.attrs,
      body: text.slice(op.openEnd, closeStart).trim(),
    });
    cursor = end;
  }
  return out;
}

/** The first block with a usable glued `to` — the one that becomes the card. */
function cardBlock(text: string): EmailBlock | null {
  for (const b of completeEmailBlocks(text)) {
    if (extractEmailAttr(b.attrs, 'to')) return b;
  }
  return null;
}

const EMAIL_TAG_PREFIX = '[SEND_EMAIL';
/** A quoted span ending in `…[SEND_EMAIL<attrs>=<ws>` — the span's closing
 *  quote is a LATER tag's value-opener (round-4 finding 1). `[^(\\[\\])]`
 *  may cross quotes/`=` (the swallowed tag's earlier attrs) but not brackets. */
const RUNAWAY_TAIL_RE = /\[SEND_EMAIL\b[^\[\]]*=\s*$/i;
/** Longest opener tag the display scan will read (0febb5f1). Real tags are a
 *  few hundred chars at most; the bound keeps a pathological many-opener
 *  message linear (D4) — the tokenizer is single-pass, but a bracketless
 *  opener must not read to end-of-text once per opener. */
const MAX_EMAIL_TAG = 4096;

/** End index (exclusive) of the SEND_EMAIL opener tag starting at `start`,
 *  or -1. Ticket 0febb5f1 (review finding 1): the leftover loop's windowed
 *  regex pair failed on a MALFORMED tag that a closer still follows — a
 *  quoted value containing `]` (the 8d7d07b0 specimen, to="[recipient]")
 *  defeats the quote-BLIND scan, a tag past SCAN_WINDOW defeats both — and
 *  the BROKEN rule then cut to end-of-text, deleting the block's body AND
 *  every byte of trailing prose. This LINEAR scan reads the tag the way it
 *  was written and cuts exactly the tag:
 *    - `=` + optional whitespace + a QUOTED value: any chars until the
 *      matching quote — `]`, `[`, newlines included;
 *    - `=` + an UNQUOTED value: chars until whitespace / `]` / `[` — an
 *      apostrophe inside it is a plain char (`subject=Bob's`, the F2 shape);
 *    - bare words (attribute names, or a markdown link's label text);
 *  and fails on a bare `[` (D3), an unterminated quote, or no `]` within
 *  MAX_EMAIL_TAG. A tag whose quoted value swallows a later COMPLETE block
 *  is rejected by the CALLER against the block list (round-3 findings 1+2).
 *  Display-only: completeEmailBlocks (the CARD parser) stays regex-strict, so
 *  a malformed tag yields NO card and its body stays as prose — the documented
 *  no-card contract. */
function scanEmailTagEnd(text: string, start: number): number {
  const n = Math.min(text.length, start + MAX_EMAIL_TAG);
  let i = start + EMAIL_TAG_PREFIX.length;
  while (i < n) {
    const c = text[i];
    if (c === ']') return i + 1; // tag end
    if (c === '[') return -1; // D3: a bare `[` is not legal inside a tag
    if (c === '=') {
      i++;
      while (i < n && /\s/.test(text[i])) i++;
      if (i >= n) return -1;
      const q = text[i];
      const close = q === '"' ? '"' : q === "'" ? "'" : q === '\u201C' ? '\u201D' : q === '\u2018' ? '\u2019' : '';
      if (close) {
        // Round-2 finding 2 / round-3 findings 1+2: a BOUNDED manual scan,
        // never indexOf — indexOf read to end-of-text once per opener
        // (measured 2.4 s at 16k openers). The loop is capped at n, so a
        // pathological many-opener message stays O(K x MAX_EMAIL_TAG).
        let j = -1;
        for (let k = i + 1; k < n; k++) {
          if (text[k] === close) { j = k; break; }
        }
        if (j < 0) return -1; // unterminated within the bound
        // Round-4 finding 1 (RUNAWAY check): if this span's closing quote
        // directly follows a `=`-assignment (`…[SEND_EMAIL to="`), the quote
        // we just closed is plausibly a LATER TAG's value-opener — our span
        // swallowed that tag (and any prose with it). That is the structural
        // signature of the runaway; marker text as inert VALUE (`subject="see
        // [SEND_EMAIL] here"`) ends with ordinary characters, never `=`, so
        // it passes. Escape hatch: when the tag CLOSES immediately after the
        // quote (`…to="]`), the inner `=`-tail is template text inside a
        // terminated value — the tag is well-formed and main parses it as a
        // card, so it is accepted. The block-start check in emailDisplayCuts
        // remains as defense in depth for tails this regex cannot see.
        if (text[j + 1] !== ']' && RUNAWAY_TAIL_RE.test(text.slice(i + 1, j))) return -1;
        i = j + 1;
      } else {
        // unquoted value: an apostrophe/quote inside it is a plain char
        while (i < n) {
          const ch = text[i];
          if (/\s/.test(ch) || ch === ']' || ch === '[') break;
          i++;
        }
      }
    } else {
      // (A quote in BARE position — inside a bare word like `O'Brien` — is a
      // plain char: rejecting it broke exactly the apostrophe-in-attrs shapes
      // this fix exists for. The runaway check above is what catches a span
      // that swallowed a later tag.)
      i++; // bare word char / whitespace between attributes
    }
  }
  return -1;
}

/**
 * Display cuts (source-text coordinates, merged, sorted) for every piece of
 * SEND_EMAIL markup in `text` — ticket 8d7d07b0:
 *   - the CARD block (card !== null): the WHOLE block. Its body lives in the
 *     card, so keeping it as prose would duplicate it.
 *   - every OTHER complete block: the opener tag and the closer token only.
 *     The body is real content the model wrote for the user and must survive
 *     display even when no card could be parsed from it — the pre-fix code
 *     either rendered the whole block raw (no-card path) or, in the first
 *     repair attempt, silently deleted it.
 *   - leftover opener tags (quote-aware AND quote-blind scans, merged —
 *     whichever ends later), bracketless openers (no `]` at all) to
 *     end-of-text, and stray closer tokens: cut as bare tags/tokens — never
 *     the prose around them (a bare `[/SEND_EMAIL]` next to real text is a
 *     marker, not a split-block tail; review N1).
 * Overlapping cuts merge, so a marker nested inside a kept body is cut as a
 * tag too and nothing raw survives.
 */
function emailDisplayCuts(text: string, card: EmailBlock | null): Array<[number, number]> {
  const cuts: Array<[number, number]> = [];
  // Ticket 0febb5f1 F1: an opener tag longer than SCAN_WINDOW (a many-recipient
  // to=, a paragraph-length subject) fails BOTH bounded scans in the leftover
  // loop below, and its BROKEN-opener rule then cuts [start, end-of-text) —
  // merging over this block's own cut and deleting every byte of prose after
  // it, although the block itself parsed perfectly. A complete block's cuts
  // already own its opener tag (whole block for the card, tag+closer for the
  // others), so the leftover scan SKIPS block starts entirely.
  const blocks = completeEmailBlocks(text);
  const blockStarts = new Set(blocks.map(b => b.start));
  for (const b of blocks) {
    if (card && b.start === card.start) cuts.push([b.start, b.end]);
    else cuts.push([b.start, b.openEnd], [b.closeStart, b.end]);
  }
  const push = (re: RegExp) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) cuts.push([m.index, m.index + m[0].length]);
  };
  const openers = /\[SEND_EMAIL\b/gi;
  // Round-3 finding 3: closer positions, collected ONCE (a per-opener
  // indexOf would rescan the tail once per opener — O(K x N) on a
  // many-opener message); openers are visited in ascending order, so a
  // two-pointer walk finds each BROKEN opener's bounding closer in O(1).
  const closerPositions: number[] = [];
  {
    const cr = /\[\/SEND_EMAIL\]/gi;
    let cm: RegExpExecArray | null;
    while ((cm = cr.exec(text))) closerPositions.push(cm.index);
  }
  let closerPtr = 0;
  let m: RegExpExecArray | null;
  // D4: bound the per-opener tag scan (a real tag is at most a few hundred
  // chars; a pathological many-opener message stays linear, not quadratic),
  // and build each bounded scanner ONCE, not per opener.
  const SCAN_WINDOW = 1024;
  const blindRe = /^\[SEND_EMAIL\b[^\[\]]*\]/i;
  while ((m = openers.exec(text))) {
    // F1: a complete block's own cuts already own this opener tag (whole block
    // when it is the card, tag+closer otherwise) — scanning it again with the
    // 1024-char window would misclassify an oversized-but-valid tag as BROKEN.
    if (blockStarts.has(m.index)) continue;
    // 0febb5f1 review finding 1: the token scan (see scanEmailTagEnd) locates
    // the tag even when it is malformed (apostrophe in an unquoted value) or
    // longer than SCAN_WINDOW — as long as its quotes terminate and it holds
    // no bare `[` — and cuts exactly the tag, so the body and the trailing
    // prose survive. D2/N1 link-label
    // check preserved: only a tag carrying NO attribute followed by `(` is a
    // label; a real opener always has to=/subject=/cc=/bcc=, and skipping
    // THOSE would leak raw markup — the ticket's own class.
    const tagEnd = scanEmailTagEnd(text, m.index);
    // Round-3 findings 1+2: reject a tokenized tag that would SWALLOW a later
    // complete block (an unterminated quote ran to that block's opener — the
    // round-2 class, which the marker-stop heuristic both missed when the
    // later opener was lowercase and over-fired on marker text inside a
    // legitimate value). The block list is authoritative — case-insensitive
    // and word-boundary-correct — so this cannot over- or under-fire. blocks
    // are sorted by start; binary-search the first block starting after
    // m.index (a linear some() would be O(K x B) on a many-opener message).
    let swallowsBlock = false;
    if (tagEnd >= 0) {
      let lo = 0, hi = blocks.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (blocks[mid].start <= m.index) lo = mid + 1; else hi = mid;
      }
      swallowsBlock = lo < blocks.length && blocks[lo].start < tagEnd;
    }
    if (tagEnd >= 0 && !swallowsBlock) {
      const attrs = text.slice(m.index + EMAIL_TAG_PREFIX.length, tagEnd - 1);
      if (!attrs.includes('=') && text[tagEnd] === '(') continue;
      cuts.push([m.index, tagEnd]);
      continue;
    }
    const after = text.slice(m.index, m.index + SCAN_WINDOW);
    // A quote-blind tag (unterminated quote, no `[` inside): bounded — cut it.
    const blind = blindRe.exec(after);
    if (blind) {
      const attrs = blind[0].slice('[SEND_EMAIL'.length, -1);
      if (!attrs.includes('=') && text[m.index + blind[0].length] === '(') continue;
      cuts.push([m.index, m.index + blind[0].length]);
      continue;
    }
    // BROKEN opener — neither bounded scan can close the tag (bracketless, or
    // a `[`/quote tail): a truncated streaming block. Cut to END of text when
    // no closer token follows (exactly what stripLiveTags hides live and the
    // old `[\s\S]*$` rule cut; D3: the first `]` after it belongs to prose
    // like "[this]", not to the tag — a half-cut there is the silent prose
    // loss round 2 flagged). Round-3 finding 3: when a closer DOES follow,
    // bound the cut there instead — an unparseable-but-closable tag (e.g. a
    // quoted value past the 4096 span cap) must not take the whole tail
    // with it; the two-pointer walk keeps this O(1) per opener.
    while (closerPtr < closerPositions.length && closerPositions[closerPtr] < m.index) closerPtr++;
    const nextCloser = closerPtr < closerPositions.length ? closerPositions[closerPtr] : -1;
    cuts.push([m.index, nextCloser >= 0 ? nextCloser + '[/SEND_EMAIL]'.length : text.length]);
  }
  push(/\[\/SEND_EMAIL\]/gi); // closer tokens
  cuts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const c of cuts) {
    const last = merged[merged.length - 1];
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
    else merged.push([c[0], c[1]]);
  }
  return merged;
}

/** Apply merged cuts to a string (right-to-left so coordinates stay valid).
 *  No cuts → byte-identical input (review D2: a text that merely MENTIONS
 *  send_email — a word in prose or code — must not be whitespace-normalized). */
function applyCuts(text: string, cuts: Array<[number, number]>): string {
  if (!cuts.length) return text;
  // Round-4 finding 2: the right-to-left slice loop was O(cuts x N) — with
  // many DISJOINT cuts (K malformed openers, each bounded at its own closer)
  // it rebuilt the string K times (measured 1.9 s at 16k, 7.9 s at 32k).
  // cuts arrive sorted and merged, so one forward walk is O(N + cuts).
  let out = '';
  let cursor = 0;
  for (const [from, to] of cuts) {
    if (from > cursor) out += text.slice(cursor, from);
    if (to > cursor) cursor = to;
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Drop merged joined-text cuts from the text parts. Non-text parts stay, and
 *  a text part that overlaps NO cut keeps its bytes AND its object reference
 *  (review N4: a marker elsewhere in the message must not normalize this
 *  part's whitespace). */
function exciseSpans<P extends { type: string; text?: string }>(
  parts: P[],
  cuts: Array<[number, number]>,
): P[] {
  const ranges: Array<{ index: number; from: number; to: number }> = [];
  let pos = 0;
  parts.forEach((p, index) => {
    if (p.type !== 'text') return;
    const text = p.text || '';
    ranges.push({ index, from: pos, to: pos + text.length });
    pos += text.length;
  });
  const next = parts.map((p, i) => {
    const range = ranges.find(r => r.index === i);
    if (!range) return p;
    const overlapping = cuts.filter(c => c[0] < range.to && c[1] > range.from);
    if (!overlapping.length) return p;
    const text = p.text || '';
    let out = '';
    let cursor = range.from;
    for (const c of overlapping) {
      const cutFrom = Math.max(c[0], range.from);
      const cutTo = Math.min(c[1], range.to);
      if (cutFrom > cursor) out += text.slice(cursor - range.from, cutFrom - range.from);
      cursor = Math.max(cursor, cutTo);
    }
    if (cursor < range.to) out += text.slice(cursor - range.from);
    const kept = out.replace(/\n{3,}/g, '\n\n').trim();
    return { ...p, text: kept };
  });
  return next.filter(p => p.type !== 'text' || (p.text || '').trim().length > 0);
}

/** Parse a [SEND_EMAIL ...attrs...]body[/SEND_EMAIL] block from text (port of
 *  page.tsx's parseEmailDraft). cleanText always has the MARKUP removed for
 *  display; emailDraft is null when there is no usable recipient — and a
 *  block that yields no card still keeps its BODY as plain text (it is
 *  content, not markup). Ticket 8d7d07b0: the no-draft early returns used to
 *  hand back the RAW text, so an unparseable block rendered its raw
 *  [SEND_EMAIL]…[/SEND_EMAIL] markup on reload although stripLiveTags had
 *  hidden the very same block live. A text with NO markup at all (a mere
 *  mention of send_email in prose or code — review D2) is byte-identical. */
export function parseEmailDraft(text: string): { cleanText: string; emailDraft: EmailDraft | null } {
  if (!/\/?send_email/i.test(text)) return { cleanText: text, emailDraft: null };
  const card = cardBlock(text);
  let emailDraft: EmailDraft | null = null;
  if (card) {
    const to      = extractEmailAttr(card.attrs, 'to');
    const subject = extractEmailAttr(card.attrs, 'subject');
    const cc      = extractEmailAttr(card.attrs, 'cc');
    const bcc     = extractEmailAttr(card.attrs, 'bcc');
    emailDraft = { to, subject, body: card.body, ...(cc && { cc }), ...(bcc && { bcc }) };
  }
  return { cleanText: applyCuts(text, emailDisplayCuts(text, card)), emailDraft };
}

/**
 * Pull a [SEND_EMAIL] draft out of a parts-bearing answer. The MARKUP is cut
 * from text parts — including when it is split across them — so raw
 * [SEND_EMAIL] tags never render; the card block's body is cut too (it lives
 * in the card), while a no-card block's body stays as prose (ticket
 * 8d7d07b0). Non-text parts stay in order. No marker in any text part → the
 * ORIGINAL parts array (same reference; even when content alone carries a
 * draft — parts render from parts).
 */
export function extractEmailFromParts<P extends { type: string; text?: string }>(
  parts: P[],
  content?: string,
): { parts: P[]; emailDraft: EmailDraft | null } {
  const joined = parts.filter(p => p.type === 'text').map(p => p.text || '').join('');
  const card = cardBlock(joined);
  let emailDraft: EmailDraft | null = null;
  if (card) {
    const to      = extractEmailAttr(card.attrs, 'to');
    const subject = extractEmailAttr(card.attrs, 'subject');
    const cc      = extractEmailAttr(card.attrs, 'cc');
    const bcc     = extractEmailAttr(card.attrs, 'bcc');
    emailDraft = { to, subject, body: card.body, ...(cc && { cc }), ...(bcc && { bcc }) };
  } else if (content) {
    emailDraft = parseEmailDraft(content).emailDraft;
  }
  const partMarker = parts.some(p => p.type === 'text' && /\[\/?send_email/i.test(p.text || ''));
  if (!partMarker) return { parts, emailDraft };
  const cuts = emailDisplayCuts(joined, card);
  if (emailDraft && !card) {
    // The draft came from `content` while the parts hold an UNCLOSED opener
    // (a split block whose closer never made it into parts): that fragment is
    // part of the card's own body — cut IT (and what follows, which the old
    // emailBlockSpan unclosed rule also cut) so the body is not shown twice.
    // Review D1/r1: anchor on the FIRST opener AFTER the last complete
    // block's closer — content's own parse pairs its closer with exactly that
    // opener, so that is where the parts' truncation begins. (The LAST opener
    // is wrong: a second, later no-card opener would leave the real fragment
    // visible AND duplicated inside the card body. Round-3 r2: if every
    // opener in parts pairs into a complete block, there is no truncation to
    // cut — parts render what they hold and the card renders content's body.)
    // Round-4 B2: a MARKDOWN LINK label is not an opener — skip bare-words
    // spans followed by '(' exactly like completeEmailBlocks does, or the
    // anchor lands on a link label and deletes the prose after it.
    const blocks = completeEmailBlocks(joined);
    const lastClose = blocks.length ? blocks[blocks.length - 1].end : 0;
    const labelRe = new RegExp(`\\[SEND_EMAIL\\b(${TAG_ATTRS})\\]`, 'gi');
    let fragStart = -1;
    let lm: RegExpExecArray | null;
    while ((lm = labelRe.exec(joined))) {
      if (lm.index < lastClose) continue;
      const attrs = lm[1] || '';
      if (!attrs.includes('=') && joined[lm.index + lm[0].length] === '(') continue; // link label
      fragStart = lm.index;
      break;
    }
    if (fragStart >= 0) cuts.push([fragStart, joined.length]);
    cuts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  return { parts: exciseSpans(parts, cuts), emailDraft };
}

/** Rewrite a model-suggested follow-up question into an imperative the user
 *  can send as-is (port of page.tsx's rewriteFollowUp). */
export function rewriteFollowUp(text: string): string {
  let s = text;
  s = s.replace(/^would you like (?:me to |to )/i, '');
  s = s.replace(/^do you want (?:me to |to )/i, '');
  s = s.replace(/^want me to /i, '');
  s = s.replace(/^should i /i, '');
  s = s.replace(/^shall i /i, '');
  s = s.replace(/^let me /i, '');
  s = s.replace(/^i could /i, '');
  s = s.replace(/^i can /i, '');
  s = s.replace(/^i'?ll /i, '');
  s = s.replace(/^i will /i, '');
  s = s.replace(/^i'?d (?:be happy|love|like) to /i, '');
  s = s.replace(/^how about i /i, '');
  s = s.replace(/^can i /i, '');
  s = s.replace(/^may i /i, '');
  s = s.replace(/\s+for you\s*([?.!]?)$/i, '$1');
  if (s.endsWith('?') && !/^(what|how|why|when|where|who|which|is |are |do |does |can |could |will |would )/i.test(s)) {
    s = s.slice(0, -1).trim();
  }
  if (s.length > 0) {
    s = s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
}

/** Email confirm card (port of page.tsx's EmailConfirmCard). Self-sufficient
 *  here: fetches the connected Google accounts on mount and sends via
 *  googleApi directly — the unified view has no page-level account state to
 *  inject. Micro-fix vs the legacy card: a parsed cc/bcc rides the send (the
 *  legacy card dropped it between the draft and the API call). */
export function PlainEmailCard({ draft }: { draft: EmailDraft }) {
  const [accounts, setAccounts] = useState<GoogleAccount[]>([]);
  const [cardState, setCardState] = useState<'preview' | 'editing' | 'sending' | 'sent' | 'cancelled'>('preview');
  const [editTo,      setEditTo]      = useState(draft.to);
  const [editSubject, setEditSubject] = useState(draft.subject);
  const [editBody,    setEditBody]    = useState(draft.body);
  const [editFrom,    setEditFrom]    = useState('');

  useEffect(() => {
    let cancelled = false;
    googleApi.listAccounts()
      .then(accs => { if (!cancelled) setAccounts(accs); })
      .catch(() => { /* no connected accounts — the From picker just stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  // Default the "From" account to the first connected one once accounts load.
  useEffect(() => {
    if (accounts.length && !editFrom) setEditFrom(accounts[0].label);
  }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const fromAccount = accounts.find(a => a.label === editFrom);
  const fromDisplay = fromAccount ? (fromAccount.email || fromAccount.label) : '';

  if (cardState === 'sent') {
    return (
      <div className="mt-4 rounded-xl border border-success-border bg-success-soft/60 dark:bg-success-soft p-4 flex items-center gap-3">
        <CheckCircle2 className="size-5 text-success flex-shrink-0" />
        <div>
          <p className="text-sm font-semibold text-success-strong">Email sent! <MailCheck className="inline size-4 -mt-0.5" aria-hidden="true" /></p>
          <p className="text-xs text-success/80 dark:text-success-accent mt-0.5">Delivered to {editTo}</p>
          {fromDisplay && (
            <p className="text-xs text-success/70 dark:text-success-accent/80 mt-0.5">Sent from {fromDisplay}</p>
          )}
        </div>
      </div>
    );
  }

  if (cardState === 'cancelled') {
    return (
      <div className="mt-4 rounded-lg border border-muted p-3 flex items-center gap-2 text-sm text-muted-foreground">
        <X className="size-4 flex-shrink-0" />
        Email draft cancelled
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-hover/40 dark:bg-hover/10 overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-2.5 bg-hover/60 dark:bg-hover/20 border-b border-line">
        <Mail className="size-4 text-ink-2 flex-shrink-0" />
        <span className="text-sm font-semibold text-ink dark:text-ink-2">Email Draft</span>
        <span className="text-xs text-ink-2">— ready to send</span>
      </div>

      <div className="p-4 space-y-3">
        {accounts.length > 1 && (
          <div className="space-y-1">
            <label className="text-[12px] font-medium text-ink-3">From</label>
            <select
              value={editFrom}
              onChange={e => setEditFrom(e.target.value)}
              className="w-full h-8 px-2 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-line-2"
            >
              {accounts.map(a => (
                <option key={a.id} value={a.label}>{a.email ? `${a.label} — ${a.email}` : a.label}</option>
              ))}
            </select>
          </div>
        )}
        {cardState === 'editing' ? (
          <>
            <div className="space-y-1">
              <label className="text-[12px] font-medium text-ink-3">To</label>
              <input
                value={editTo}
                onChange={e => setEditTo(e.target.value)}
                className="w-full h-8 px-3 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-line-2"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[12px] font-medium text-ink-3">Subject</label>
              <input
                value={editSubject}
                onChange={e => setEditSubject(e.target.value)}
                className="w-full h-8 px-3 rounded-md border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-line-2"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[12px] font-medium text-ink-3">Body</label>
              <textarea
                value={editBody}
                onChange={e => setEditBody(e.target.value)}
                rows={8}
                className="w-full px-3 py-2 rounded-md border bg-background text-sm resize-y font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-line-2"
              />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-baseline gap-3">
              <span className="text-[12px] font-medium text-ink-3 w-14 flex-shrink-0">To</span>
              <span className="text-sm">{editTo}</span>
            </div>
            <div className="flex items-baseline gap-3">
              <span className="text-[12px] font-medium text-ink-3 w-14 flex-shrink-0">Subject</span>
              <span className="text-sm font-medium">{editSubject}</span>
            </div>
            <Separator />
            <p className="text-sm whitespace-pre-wrap leading-relaxed max-h-64 overflow-y-auto">{editBody}</p>
          </>
        )}
      </div>

      <div className={cn(
        'flex items-center gap-2 px-4 py-3 border-t border-line',
        'bg-hover/30 dark:bg-hover/10'
      )}>
        {cardState === 'editing' ? (
          <>
            <Button
              size="sm"
              className="h-8 text-xs bg-send hover:bg-send/90 text-send-ink"
              onClick={() => setCardState('preview')}
            >
              <Check className="size-3.5 mr-1.5" />
              Done editing
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground"
              onClick={() => { setEditTo(draft.to); setEditSubject(draft.subject); setEditBody(draft.body); setCardState('preview'); }}
            >
              Reset
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              className="h-8 text-xs bg-send hover:bg-send/90 text-send-ink gap-1.5"
              disabled={cardState === 'sending'}
              onClick={async () => {
                setCardState('sending');
                try {
                  const result = await googleApi.sendEmail({
                    to: editTo, subject: editSubject, body: editBody,
                    ...(draft.cc && { cc: draft.cc }),
                    ...(draft.bcc && { bcc: draft.bcc }),
                    ...(editFrom && { label: editFrom }),
                  });
                  if (!result.success) throw new Error('Send failed');
                  toast.success(<span className="inline-flex items-center gap-1.5">Email sent to {editTo}! <MailCheck className="size-3.5" /></span>);
                  setCardState('sent');
                } catch {
                  setCardState('preview');
                  toast.error('Failed to send email. Please try again.');
                }
              }}
            >
              {cardState === 'sending'
                ? <><Loader2 className="size-3.5 animate-spin" />Sending…</>
                : <><Send className="size-3.5" />Send</>
              }
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs border-line text-ink dark:text-ink-2 hover:bg-hover "
              onClick={() => setCardState('editing')}
            >
              <Pencil className="size-3.5 mr-1.5" />
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs text-muted-foreground hover:text-destructive ml-auto"
              onClick={() => setCardState('cancelled')}
            >
              <X className="size-3.5 mr-1" />
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Sources — compact chip row (audit 2026-09-15, the Claude/Perplexity idiom):
 * "Sources · N" inline with monogram tiles (first letter of the host — no
 * external favicon fetches, nothing leaves the page), host + page, the first
 * SOURCES_VISIBLE chips with a "+N more" toggle. The relevance % is admin-only
 * (`showScores`): a retrieval score means nothing to a reader.
 */
const SOURCES_VISIBLE = 6;
export function PlainSourcesRow({ sources, showScores }: { sources: NonNullable<PlainMessageMeta['sources']>; showScores?: boolean }) {
  const [all, setAll] = useState(false);
  if (!sources?.length) return null;
  const shown = all ? sources : sources.slice(0, SOURCES_VISIBLE);
  const hidden = sources.length - shown.length;
  return (
    <div className="pt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground/80 mr-0.5 select-none">Sources · {sources.length}</span>
        {shown.map((source, si) => {
          // Resolve redirect wrappers (legacy rows predate the backend unwrap,
          // feedback a2063c30) so the chip shows and LINKS the real destination.
          const url = source.mimeType === 'url' ? resolveSourceUrl(source.documentName) : null;
          const safeUrl = url && /^https?:\/\//i.test(url) ? url : null;
          const label = source.mimeType === 'url'
            ? sourceDisplayHost(source.documentName)
            : source.documentName;
          const page = source.metadata?.page ? ` · p.${source.metadata.page}` : '';
          const monogram = (label || '?').replace(/^www\./i, '').trim().charAt(0).toUpperCase() || '?';
          // Agent-engine web sources carry no relevanceScore — hide the % instead of NaN%.
          const score = showScores && Number.isFinite(source.relevanceScore) ? Math.round(source.relevanceScore! * 100) : null;
          const chipCls = cn(
            'inline-flex items-center gap-1.5 text-[11px] rounded-full border border-border/60 bg-background pl-1 pr-2.5 py-0.5 text-foreground/80 transition-colors',
            safeUrl ? 'hover:bg-muted hover:border-foreground/20 cursor-pointer' : 'cursor-default',
          );
          const inner = (
            <>
              <span aria-hidden className={cn('inline-flex size-4 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold', source.mimeType === 'url' ? 'bg-active text-ink-2' : 'bg-muted text-muted-foreground')}>
                {source.mimeType === 'url' ? monogram : '¶'}
              </span>
              <span className="max-w-[160px] truncate">{label}{page}</span>
              {score !== null && <span className="text-muted-foreground/70 tabular-nums">{score}%</span>}
            </>
          );
          return safeUrl ? (
            <a key={si} href={safeUrl} target="_blank" rel="noopener noreferrer" title={safeUrl} className={chipCls}>
              {inner}
            </a>
          ) : (
            <span key={si} title={source.content} className={chipCls}>
              {inner}
            </span>
          );
        })}
        {hidden > 0 && (
          <button type="button" onClick={() => setAll(true)}
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] text-muted-foreground/80 hover:text-foreground hover:bg-muted select-none">
            +{hidden} more
          </button>
        )}
        {all && sources.length > SOURCES_VISIBLE && (
          <button type="button" onClick={() => setAll(false)}
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] text-muted-foreground/80 hover:text-foreground hover:bg-muted select-none">
            Show fewer
          </button>
        )}
      </div>
    </div>
  );
}

/** "Suggested next" follow-up chips (port of page.tsx's followUps row). onPick
 *  fills the composer for review/edit before sending — same as the legacy
 *  click (setInput + focus, never auto-send). */
export function PlainFollowUps({ followUps, disabled, onPick, trailing }: {
  followUps: string[];
  disabled?: boolean;
  onPick: (rewritten: string) => void;
  /** Digby Frontier: the "Dig deeper" pill rides LAST in this row. */
  trailing?: React.ReactNode;
}) {
  if (!followUps?.length && !trailing) return null;
  // Digby Frontier (2026-10-06): plain pills — 8px 14px, radius 999, 1px line,
  // transparent, 13.5px ink-2; hover bg-hover + line-2 + ink. No "Suggested
  // next" label, no chevrons; Dig deeper is the last pill.
  return (
    <div className="mt-[18px] flex flex-wrap gap-2 font-sans" data-follow-ups>
      {(followUps ?? []).map((q, qi) => {
        const rewritten = rewriteFollowUp(q);
        return (
          <button
            key={qi}
            onClick={() => onPick(rewritten)}
            disabled={disabled}
            className="inline-flex items-center gap-2 text-[13.5px] px-3.5 py-2 rounded-full border border-line bg-transparent text-ink-2 transition-colors duration-150 hover:bg-hover hover:border-line-2 hover:text-ink text-left leading-snug disabled:opacity-50"
          >
            {rewritten}
          </button>
        );
      })}
      {trailing}
    </div>
  );
}

// Per-model response labels + id cleanup (ports of page.tsx's MODEL_LABELS /
// cleanModelId — keep in sync manually until the legacy view is deleted).
// Persona labels (owner ticket 7bdbe40c): displayModelName normalizes every
// runtime id (Fireworks paths, legacy aliases, backend labels) to a persona;
// unknown ids render 'AI Agent' rather than leaking a vendor string.
// Seat card keys (owner 2026-09-15 — the backend keys chat cards by SEAT, and
// `meta.modelLabels` carries the seat label for each key) come first; the
// vendor keys below them are legacy transcripts (default lineup labels).
const PLAIN_MODEL_LABELS: Record<string, string> = {
  digby: SEAT_LABELS.digby,
  double_checker: SEAT_LABELS.double_checker,
  triple_checker: SEAT_LABELS.triple_checker,
  openai: 'The Veteran',
  grok: 'The Maverick',
  gemini: 'The Scholar',
  glm: SEAT_LABELS.triple_checker,
  kimi: SEAT_LABELS.digby,
  deepseek: SEAT_LABELS.double_checker,
};
/** Fixed card order: the seats, then consultants, then legacy vendor keys. */
const PLAIN_CARD_ORDER = ['digby', 'double_checker', 'triple_checker', 'openai', 'grok', 'gemini', 'glm', 'kimi', 'deepseek'];

interface PlainModelResponse {
  model?: string;
  response?: string;
  time?: number;
  error?: string;
  modelUsed?: string;
  webSearchUsed?: boolean;
  toolCalls?: Array<{ name: string; args: Record<string, string> }>;
}

/** One model's response card inside the More-info panel (port of page.tsx's
 *  ModelCard — think-block split, status icon, badges, markdown answer). */
export function PlainModelCard({ label, response }: { label: string; response?: PlainModelResponse }) {
  if (!response) return null;
  const thinkMatch = response.response?.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)/s);
  const thinkingContent = thinkMatch ? thinkMatch[1].trim() : '';
  const actualResponse  = thinkMatch ? thinkMatch[2].trim() : (response.response || '');

  const hasContent = !response.error && actualResponse.trim() !== '';
  const isError = !!response.error;
  const isEmpty = !isError && !hasContent && !thinkingContent;

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-b gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className="font-semibold text-sm">{label}</span>
          {isError ? (
            <XCircle className="size-3.5 text-destructive flex-shrink-0" />
          ) : isEmpty ? (
            <AlertCircle className="size-3.5 text-warn-ink flex-shrink-0" />
          ) : (
            <CheckCircle2 className="size-3.5 text-success-accent flex-shrink-0" />
          )}
          {/* The More-info panel is the ADMIN debugging surface (owner
              directive 2026-07-24): show the model id that ACTUALLY served
              this seat, verbatim — the whole point of the panel is checking
              that the configured seats are what ran (owner 2026-09-15). */}
          {response.modelUsed && (
            <Badge variant="outline" className="text-[10px] font-mono py-0 h-4 px-1.5 max-w-[220px] truncate" title={`served by ${response.modelUsed}`}>
              {response.modelUsed}
            </Badge>
          )}
          {response.webSearchUsed && (
            <Badge variant="outline" className="text-[10px] py-0 h-4 px-1.5 text-ink-2 border-line">
              <Globe className="size-2.5 mr-0.5" />
              web
            </Badge>
          )}
          {response.toolCalls && response.toolCalls.length > 0 && response.toolCalls.map((tc, i) => (
            <Badge key={i} variant="outline" className="text-[10px] py-0 h-4 px-1.5 text-ink-2 border-line max-w-[200px]" title={`${tc.name}(${JSON.stringify(tc.args)})`}>
              {tc.name === 'search_engine' && '🔍'}
              {tc.name === 'scrape_as_markdown' && '🌐'}
              {tc.name === 'scrape_batch' && '📑'}
              <span className="truncate ml-0.5">{tc.args?.query || tc.args?.url?.substring(0, 30) || (tc.args?.urls ? `${(tc.args.urls as any).length || '?'} URLs` : tc.name)}</span>
            </Badge>
          ))}
        </div>
        {(response.time ?? 0) > 0 && (
          <Badge variant="outline" className="text-xs font-mono flex-shrink-0">
            {((response.time ?? 0) / 1000).toFixed(2)}s
          </Badge>
        )}
      </div>
      <div className="p-4 text-sm overflow-x-auto min-w-0 space-y-2">
        {isError ? (
          <p className="text-destructive text-sm break-words">{response.error}</p>
        ) : isEmpty ? (
          <p className="text-warn-ink text-sm italic">No response content returned from this model.</p>
        ) : (
          <>
            {thinkingContent && (
              <details className="mb-2">
                <summary className="text-[11px] text-muted-foreground cursor-pointer select-none hover:text-foreground transition-colors">
                  🧠 Thinking ({Math.round(thinkingContent.length / 4)} tokens)
                </summary>
                <div className="mt-1.5 pl-3 border-l border-muted text-muted-foreground text-xs leading-relaxed whitespace-pre-wrap">
                  {thinkingContent}
                </div>
              </details>
            )}
            {hasContent ? (
              <MarkdownContent compact>{actualResponse}</MarkdownContent>
            ) : (
              <p className="text-muted-foreground text-xs italic">
                Reasoning captured — see the synthesized answer above.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** More-info panel (port of page.tsx's admin-only model breakdown): mode
 *  badge + per-model timings summary + one card per model response. The
 *  legacy panel keyed its open state by message index; co-locating the state
 *  here is simpler and survives the unified view's transcript windowing. */
export function PlainMoreInfo({ meta }: { meta: PlainMessageMeta }) {
  const [open, setOpen] = useState(false);
  const models = meta.models;
  if (!models || typeof models !== 'object') return null;
  const summaryKeys = meta.modelSet === 'open_source'
    ? ['digby', 'double_checker', 'triple_checker', 'glm', 'kimi', 'deepseek']
    : ['openai', 'grok', 'gemini'];
  // Fixed order for the known slots, then any extra keys the backend adds.
  const cardKeys = PLAIN_CARD_ORDER
    .filter(k => models[k] !== undefined)
    .concat(Object.keys(models).filter(k => !PLAIN_CARD_ORDER.includes(k)));
  return (
    <div className="pt-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md transition-colors text-[11px] text-muted-foreground/70 hover:text-foreground hover:bg-muted"
        title="Show model timings and individual responses"
      >
        <span>More info</span>
        <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="pt-2 space-y-3">
          <div className="flex items-center gap-x-2 gap-y-0.5 flex-wrap text-[11px] text-muted-foreground">
            <Badge variant="secondary" className="text-[10px] capitalize py-0 h-4 flex-shrink-0">
              {meta.mode === 'deep_research_all' ? (
                <><Search className="size-2.5 mr-0.5" />All Models</>
              ) : meta.mode === 'deep_research' ? (
                <><Search className="size-2.5 mr-0.5" />Deep Research</>
              ) : meta.mode === 'thinking' ? (
                <><Brain className="size-2.5 mr-0.5" />Thinking</>
              ) : meta.mode === 'single_thinking' ? (
                <><Brain className="size-2.5 mr-0.5" />Single Thinking</>
              ) : meta.mode === 'single' ? (
                <><Zap className="size-2.5 mr-0.5" />Single</>
              ) : (
                <><Zap className="size-2.5 mr-0.5" />Fast</>
              )}
            </Badge>
            {summaryKeys.map((m) => {
              const r = models[m] as PlainModelResponse | undefined;
              if (!r) return null;
              return (
                <span key={m} className="flex items-center gap-0.5">
                  <span>{displayModelName(meta.modelLabels?.[m] || PLAIN_MODEL_LABELS[m] || m)}</span>
                  {r.error
                    ? <XCircle className="size-3 text-destructive" />
                    : <CheckCircle2 className="size-3 text-success-accent" />}
                  <span className="font-mono">{((r.time ?? 0) / 1000).toFixed(1)}s</span>
                </span>
              );
            })}
            {meta.synthesisTime !== undefined && meta.synthesisTime > 0 && meta.mode !== 'single' && meta.mode !== 'single_thinking' && (
              <span>Synthesis: {(meta.synthesisTime / 1000).toFixed(1)}s</span>
            )}
            {meta.totalTime !== undefined && meta.totalTime > 0 && (
              <span>Total: {(meta.totalTime / 1000).toFixed(1)}s</span>
            )}
          </div>
          {cardKeys.map(k => (
            <PlainModelCard key={k} label={displayModelName(meta.modelLabels?.[k] || PLAIN_MODEL_LABELS[k] || k)} response={models[k]} />
          ))}
        </div>
      )}
    </div>
  );
}

// One playing TTS clip across ALL action rows (port of page.tsx's shared
// audioPlayerRef): starting a new read-aloud stops the previous one AND clears
// its row's speaking state via this module-level stop hook.
let stopPlainReadAloud: (() => void) | null = null;

/**
 * Assistant-message action row (Copy / Read aloud / Report issue) — port of
 * page.tsx's action+meta row (covers review M7) as a SHARED, self-contained
 * component: copy state, TTS playback, and the thumbs-down feedback form all
 * live here. Used by the unified plain transcript; page.tsx can adopt it in a
 * later pass (its own copy is untouched for now).
 */
export function PlainMessageActions({ content, chatId, modelSet, messageId, isKid, timeLabel, alwaysVisible, onRetry, trailing }: {
  content: string;
  chatId: string;
  modelSet?: string;
  /** Digby Frontier (2026-10-06): the LATEST answer's row is always visible;
      older rows stay hover/focus-revealed on pointer devices. */
  alwaysVisible?: boolean;
  /** RotateCcw — re-send the question this answer replied to. */
  onRetry?: () => void;
  /** After a 1×16px divider: the transparency pill ("Checked by 2 models"). */
  trailing?: React.ReactNode;
  /** The message's send time (owner 2026-09-17): every stamp lives UNDERNEATH
      the message, in this row — never a corner overlay on the prose. */
  timeLabel?: string;
  /** crossModelMessage row id (ticket 017f090b) — links the feedback row to this answer. */
  messageId?: string;
  /** Digby Kids (C3 kid flip, design D5): Copy + Read aloud stay (legacy shows
      them to kids too); the Report-issue control is ADULT-ONLY — same
      `!isKid` gate the legacy transcript's action row applies. */
  isKid?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [fbOpen, setFbOpen] = useState(false);
  const [fbReason, setFbReason] = useState<FeedbackReason | ''>('');
  const [fbComment, setFbComment] = useState('');
  const [fbSubmitting, setFbSubmitting] = useState(false);
  const [fbSubmitted, setFbSubmitted] = useState(false);
  const [thumbsUp, setThumbsUp] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }).catch(() => toast.error('Failed to copy'));
  };

  const handleThumbsUp = async () => {
    if (thumbsUp || fbSubmitted) return;
    setThumbsUp(true);
    try {
      await feedbackApi.submit({
        chatId,
        messageId,
        type: 'thumbs_up',
        modelSet: modelSet === 'frontier' || modelSet === 'open_source' ? modelSet : undefined,
      });
    } catch {
      setThumbsUp(false);
      toast.error('Failed to send feedback');
    }
  };

  /**
   * Ticket 2774d2b7 ("text to speech button doesn't work at all just spins
   * and dies"): the old read-aloud asked ONE /tts request that synthesized the
   * whole answer server-side — ~14 s per 600-char chunk, strictly sequential,
   * so a multi-paragraph answer spent 50-130 s inside axios' 45 s default
   * timeout (lib/api-client.ts). The request aborted, the spinner stopped and
   * a toast said "Text-to-speech failed" — no audio, no backend error row
   * (the backend never saw a failure; the client had already left).
   *
   * Progressive playback instead (voiceApi.ttsStream): the backend flushes
   * each ≤600-char chunk the moment it synthesizes; the FIRST chunk starts
   * playing in ~5-15 s while the rest still synthesize. Chunks queue and play
   * strictly in TEXT order (`index`) — completion order can differ under
   * bounded concurrency; a chunk that completes while an earlier one is still
   * playing just waits in the map. Clicking again stops everything (the
   * module-level stop hook, same contract as before).
   */
  const handleReadAloudProgressive = async () => {
    if (speaking) { stopPlainReadAloud?.(); return; }
    stopPlainReadAloud?.();
    setTtsLoading(true);
    // Strip markdown for cleaner TTS audio (same regex chain as the legacy path).
    const cleanText = content
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/#+\s/g, '')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/[#*`>]/g, '')
      .replace(/\n+/g, ' ')
      .trim()
      .slice(0, 4096);
    const abort = new AbortController();
    const clipsByIndex = new Map<number, HTMLAudioElement>();
    let stopped = false;
    let current = -1;    // index of the clip playing
    let nextToPlay = 0;  // TEXT order — chunk 0 first, always
    let playedFirst = false;
    let streamDone = false;  // the terminal line arrived (done or error)
    let arrivedCount = 0;    // chunk lines received
    let endedCount = 0;      // clips that finished playing
    const stopAll = () => {
      if (stopped) return;
      stopped = true;
      abort.abort();
      for (const el of clipsByIndex.values()) { el.onended = null; el.onerror = null; el.pause(); }
      setSpeaking(false);
      if (stopPlainReadAloud === stopAll) stopPlainReadAloud = null;
    };
    stopPlainReadAloud = stopAll;
    const checkNaturalCompletion = () => {
      // Review finding #7 + #10: once the terminal line arrived and every
      // delivered clip has played, either advance past an index that never
      // arrived (a torn NDJSON line — the only silent-gap path) or clear the
      // speaking state — the button must not stay in "Stop reading" (nor the
      // row pinned open) after the answer finished playing.
      if (stopped || !streamDone || arrivedCount === 0 || endedCount < arrivedCount) return;
      const next = [...clipsByIndex.keys()].filter((i) => i >= nextToPlay).sort((a, b) => a - b)[0];
      if (next !== undefined) { nextToPlay = next; playNext(); return; }
      stopAll();
    };
    const playNext = () => {
      if (stopped) return;
      const el = clipsByIndex.get(nextToPlay);
      if (!el) {
        checkNaturalCompletion(); // maybe the whole answer already played out
        return; // still synthesizing — the arriving chunk resumes the queue
      }
      current = nextToPlay;
      void el.play().catch(() => { stopAll(); toast.error('Failed to play audio'); });
    };
    try {
      const outcome = await voiceApi.ttsStream(
        cleanText,
        undefined,
        (chunk) => {
          if (stopped) return;
          arrivedCount++;
          const el = new Audio(`data:${chunk.mimeType};base64,${chunk.audio}`);
          clipsByIndex.set(chunk.index, el);
          el.onended = () => {
            endedCount++;
            if (current === chunk.index) { nextToPlay = current + 1; playNext(); }
            else checkNaturalCompletion();
          };
          el.onerror = () => { stopAll(); toast.error('Failed to play audio'); };
          if (!playedFirst) {
            // First chunk in: start at once; the rest synthesize while it plays.
            playedFirst = true;
            setTtsLoading(false);
            setSpeaking(true);
            if (chunk.index === 0) { nextToPlay = 0; playNext(); }
            // else: a later chunk landed first (out-of-order completion) —
            // playback starts when chunk 0 arrives; onended of the LAST clip
            // handles the tail once every index exists.
          } else if (nextToPlay === chunk.index && clipsByIndex.has(nextToPlay)) {
            playNext(); // exactly the chunk the player was waiting on
          }
          // A gap chunk (not the awaited one): stays in the map.
        },
        abort.signal,
      );
      if ('error' in outcome) {
        streamDone = true;
        const played = playedFirst;
        stopAll();
        toast.error(played
          ? 'Read aloud stopped early — the speech service dropped part of the answer.'
          : 'Text-to-speech failed. Please try again.');
        return;
      }
      streamDone = true;
      if (!playedFirst) { setTtsLoading(false); setSpeaking(true); }
      // Every chunk synthesized. If playback never started (a later chunk
      // landed first and chunk 0 was dropped by the vendor), start it now on
      // whatever exists; else maybe everything already played out.
      if (!stopped) {
        if (!playedFirst && clipsByIndex.size > 0 && !clipsByIndex.has(nextToPlay)) {
          nextToPlay = Math.min(...clipsByIndex.keys());
          playNext();
        } else {
          checkNaturalCompletion();
        }
      }
    } catch {
      // Review finding #8: a user-initiated stop (abort) must not toast an
      // error — the stop was intentional, not a failure.
      if (stopped) return;
      stopAll();
      toast.error('Text-to-speech failed. Please try again.');
    } finally {
      setTtsLoading(false);
    }
  };

  const handleFeedbackSubmit = async () => {
    if (fbSubmitting) return;
    // "Other" carries no meaning on its own — require a description.
    if (fbReason === 'other' && !fbComment.trim()) {
      toast.error('Please describe the issue so we can look into it');
      return;
    }
    setFbSubmitting(true);
    try {
      const result = await feedbackApi.submit({
        chatId,
        messageId,
        type: 'thumbs_down',
        reason: fbReason || undefined,
        comment: fbComment.trim() || undefined,
        modelSet: modelSet === 'frontier' || modelSet === 'open_source' ? modelSet : undefined,
      });
      setFbSubmitted(true);
      setFbOpen(false);
      setFbReason('');
      setFbComment('');
      toast.success(
        result.featureRequestId
          ? 'Feedback submitted! Track it in Account → Feedback 🙏'
          : 'Thanks for the feedback! 🙏'
      );
    } catch {
      toast.error('Failed to submit feedback');
    } finally {
      setFbSubmitting(false);
    }
  };

  // Audit 2026-09-15 (the Claude/ChatGPT/Gemini action row): icon-only
  // controls, visible on touch, hover/focus-revealed on pointer devices,
  // pinned open while a state is worth seeing (copied / speaking / form).
  // Labels stay in the DOM as sr-only text + title, so screen readers and
  // the render pins (plain-message-actions.test.tsx) read the same words.
  const pinned = copied || speaking || ttsLoading || fbOpen || !!alwaysVisible;
  // Digby Frontier action row: 30px radius-8 icon buttons in ink-3, 15px
  // icons at stroke 1.75 — Copy (→ Check for 1.4s), ThumbsUp, ThumbsDown
  // (Report issue), Volume2 (read aloud), RotateCcw (retry), then a 1×16px
  // divider and the transparency pill.
  const iconBtn = 'inline-flex size-[30px] items-center justify-center rounded-lg transition-colors duration-150 text-ink-3 hover:text-ink hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line-2';
  const ICON = 'size-[15px]';
  return (
    <>
      <div className={cn(
        'mt-2.5 flex items-center gap-0.5 flex-wrap text-ink-3 transition-opacity',
        'md:opacity-0 md:group-hover/msg:opacity-100 md:focus-within:opacity-100',
        pinned && 'md:opacity-100',
      )}>
        <button
          onClick={handleCopy}
          className={iconBtn}
          aria-label={copied ? 'Copied' : 'Copy'}
          title={copied ? 'Copied!' : 'Copy response'}
        >
          {copied
            ? <><Check className={ICON} strokeWidth={1.75} /><span className="sr-only">Copied</span></>
            : <><Copy className={ICON} strokeWidth={1.75} /><span className="sr-only">Copy</span></>
          }
        </button>
        {!isKid && !!chatId && (
        <button
          onClick={() => void handleThumbsUp()}
          className={cn(iconBtn, thumbsUp && 'text-ink')}
          aria-label={thumbsUp ? 'Thanks for the feedback' : 'Good response'}
          aria-pressed={thumbsUp}
          title={thumbsUp ? 'Thanks!' : 'Good response'}
          disabled={fbSubmitted}
        >
          <ThumbsUp className={ICON} strokeWidth={1.75} fill={thumbsUp ? 'currentColor' : 'none'} />
          <span className="sr-only">Good response</span>
        </button>
        )}
        {!isKid && !!chatId && (
        <button
          onClick={() => {
            if (fbSubmitted) return;
            setFbOpen(o => !o);
            setFbReason('');
            setFbComment('');
          }}
          className={cn(
            iconBtn,
            fbSubmitted
              ? 'text-ink cursor-default hover:bg-transparent'
              : fbOpen
              ? 'bg-hover text-ink'
              : ''
          )}
          aria-label={fbSubmitted ? 'Feedback sent' : 'Report issue'}
          title={fbSubmitted ? 'Feedback submitted ✓' : 'Bad response — report an issue'}
        >
          {fbSubmitted
            ? <><ThumbsDown className={ICON} strokeWidth={1.75} fill="currentColor" /><span className="sr-only">Feedback sent</span></>
            : <><ThumbsDown className={ICON} strokeWidth={1.75} /><span className="sr-only">Report issue</span></>
          }
        </button>
        )}
        <button
          onClick={() => void handleReadAloudProgressive()}
          className={cn(iconBtn, speaking && 'text-ink')}
          aria-label={speaking ? 'Stop reading' : 'Read aloud'}
          title={speaking ? 'Stop reading' : 'Read aloud'}
        >
          {ttsLoading
            ? <><Loader2 className={cn(ICON, 'animate-spin')} /><span className="sr-only">Read aloud</span></>
            : speaking
            ? <><VolumeX className={ICON} strokeWidth={1.75} /><span className="sr-only">Stop</span></>
            : <><Volume2 className={ICON} strokeWidth={1.75} /><span className="sr-only">Read aloud</span></>
          }
        </button>
        {onRetry && (
          <button
            onClick={onRetry}
            className={iconBtn}
            aria-label="Retry"
            title="Ask again"
          >
            <RotateCcw className={ICON} strokeWidth={1.75} />
            <span className="sr-only">Retry</span>
          </button>
        )}
        {trailing && (
          <>
            <span aria-hidden className="mx-2 h-4 w-px bg-line" />
            {trailing}
          </>
        )}
        {timeLabel && <span data-msg-time className="ml-2 text-[11px] text-ink-3 whitespace-nowrap tabular-nums select-none">{timeLabel}</span>}
      </div>
      {!isKid && !!chatId && fbOpen && !fbSubmitted && (
        <div className="dg-pop mt-2 mb-3 rounded-[14px] border border-line bg-bg-2 px-3.5 pt-3 pb-3.5 font-sans">
          <p className="text-[11px] font-medium text-foreground/80 mb-2">What was the issue? (optional)</p>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {(['wrong', 'incomplete', 'slow', 'formatting', 'harmful', 'other'] as const).map(r => (
              <button
                key={r}
                onClick={() => setFbReason(fbReason === r ? '' : r)}
                className={cn(
                  'text-[11px] px-2.5 py-1 rounded-full border transition-colors',
                  fbReason === r
                    ? 'bg-foreground text-background border-foreground'
                    : 'border-border/70 text-foreground/80 hover:bg-muted hover:border-foreground/20'
                )}
              >
                {r === 'wrong' ? 'Wrong answer' : r === 'incomplete' ? 'Incomplete' : r === 'slow' ? 'Too slow' : r === 'formatting' ? 'Formatting' : r === 'harmful' ? 'Harmful' : 'Other'}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder={fbReason === 'other' ? 'Please describe the issue…' : 'Add a comment (optional)…'}
            value={fbComment}
            onChange={e => setFbComment(e.target.value)}
            className="w-full text-xs rounded-md border border-border bg-background px-3 py-1.5 mb-2 outline-none focus:ring-1 focus:ring-ring"
            onKeyDown={e => { if (e.key === 'Enter') void handleFeedbackSubmit(); }}
          />
          <div className="flex gap-2">
            <button
              onClick={() => void handleFeedbackSubmit()}
              disabled={fbSubmitting || (fbReason === 'other' && !fbComment.trim())}
              title={fbReason === 'other' && !fbComment.trim() ? 'Please describe the issue first' : undefined}
              className="text-[11px] px-3 py-1.5 rounded-md bg-foreground text-background hover:bg-foreground/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {fbSubmitting ? 'Sending…' : 'Send feedback'}
            </button>
            <button
              onClick={() => { setFbOpen(false); setFbReason(''); setFbComment(''); }}
              className="text-[11px] px-3 py-1.5 rounded-md border text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * User-message copy button (feedback ticket 57542e64, 2026-09-21): the same
 * one-click copy the assistant action row (PlainMessageActions) has, for the
 * user's OWN bubble. The unified transcript's user row renders it UNDER the
 * bubble's right edge — absolutely positioned (`top-full right-2`; the parent
 * row is `group/msg relative`) on the same line as the per-message timestamp,
 * which shifts to right-10 to make room. Touch: always visible; pointer:
 * hover/focus-revealed and pinned while the Copied check shows (the audit
 * 2026-09-15 icon-row idiom).
 */
export function UserMessageCopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => toast.error('Failed to copy'));
  };
  return (
    <button
      onClick={handleCopy}
      className={cn(
        'absolute top-full right-2 mt-0.5 z-10 inline-flex size-6 items-center justify-center rounded-md transition text-muted-foreground/70 hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        copied
          ? 'opacity-100'
          : 'md:opacity-0 md:group-hover/msg:opacity-100 md:focus-within:opacity-100',
      )}
      aria-label={copied ? 'Copied' : 'Copy'}
      title={copied ? 'Copied!' : 'Copy message'}
    >
      {copied
        ? <><CopyCheck className="size-3.5 text-success-accent" /><span className="sr-only">Copied</span></>
        : <><Copy className="size-3.5" /><span className="sr-only">Copy</span></>
      }
    </button>
  );
}
