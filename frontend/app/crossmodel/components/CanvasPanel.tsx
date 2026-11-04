'use client';

import { useState, useCallback, useRef, useEffect, memo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { absoluteDate } from '@/lib/relative-time';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia } from '@/components/ui/empty';
import { normalizeMarkdownForRender } from '@/lib/markdown-normalize';
import {
  X,
  Copy,
  Download,
  Pencil,
  FileText,
  GitBranch,
  Send,
  Trash2,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Share2,
  Link2Off,
  Plus,
  MoreHorizontal,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { canvasApi } from '@/lib/api/crossmodel';
import { TYPE_ICONS, TYPE_LABELS, getFileExtension, sanitizeFilename } from './canvas-meta';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { markdownTableComponents } from '@/components/ui/custom/prompt/markdown-table';

// ─── Canvas Markdown Renderer ─────────────────────────────────────────────────
// Mirrors the chat MarkdownContent component: shared markdown tables, styled
// headings, and respects the user's text-size preference.

const CanvasMarkdownContent = ({ children }: { children: string }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      // Digby Frontier (2026-10-06): document prose in Newsreader 17/1.65
      // ink-2; headings in Geist 15/600 (h1 stays serif); hairline tables.
      p: ({ children }) => (
        <p className="mb-3 last:mb-0 break-words font-serif text-[17px] leading-[1.65] text-ink-2 text-pretty">{children}</p>
      ),
      h1: ({ children }) => (
        <h1 className="scroll-m-20 mt-8 mb-3 first:mt-0 font-serif text-[26px] font-normal leading-[1.2] tracking-[-0.01em] text-ink">
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2 className="scroll-m-20 mt-8 mb-2.5 first:mt-0 font-sans text-[15px] font-semibold text-ink">
          {children}
        </h2>
      ),
      h3: ({ children }) => (
        <h3 className="scroll-m-20 mt-6 mb-2 first:mt-0 font-sans text-[15px] font-semibold text-ink">
          {children}
        </h3>
      ),
      h4: ({ children }) => (
        <h4 className="scroll-m-20 mt-5 mb-1.5 font-sans text-[14px] font-semibold text-ink">
          {children}
        </h4>
      ),
      ul: ({ children }) => (
        <ul className="my-3 pl-6 list-disc space-y-1.5 marker:text-ink-3">{children}</ul>
      ),
      ol: ({ children }) => (
        <ol className="my-3 pl-7 list-decimal space-y-1.5 marker:tabular-nums marker:text-ink-3">{children}</ol>
      ),
      li: ({ children }) => (
        <li className="pl-1 break-words font-serif text-[17px] leading-[1.65] text-ink-2">{children}</li>
      ),
      // Tables — the shared MarkdownTable slice (P4; Frontier skin lives there).
      ...markdownTableComponents(),
      code: ({ className, children, ...props }: any) => {
        const isInline = !className;
        if (isInline) {
          return (
            <code className="rounded-md bg-hover px-[0.35em] py-[0.1em] font-mono text-[0.85em] text-ink">
              {children}
            </code>
          );
        }
        return (
          <pre className="my-4 overflow-x-auto rounded-xl border border-line bg-bg-2 p-4">
            <code className={cn('font-mono text-[13px] leading-relaxed', className)}>{children}</code>
          </pre>
        );
      },
      blockquote: ({ children }) => (
        <blockquote className="my-4 border-l-2 border-line-2 pl-4 italic text-ink-3">
          {children}
        </blockquote>
      ),
      hr: () => <Separator className="my-6 bg-line" />,
      strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
      em: ({ children }) => <em className="italic">{children}</em>,
      a: ({ href, children }) => (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink underline decoration-line-2 underline-offset-[3px] hover:text-ink-2 transition-colors"
        >
          {children}
        </a>
      ),
    }}
  >
    {normalizeMarkdownForRender(children)}
  </ReactMarkdown>
);

/** A document whose markdown opens with `# <its own title>` would print the
 *  title twice under the Frontier 32px serif title — drop that leading h1. */
export function stripLeadingTitle(content: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*\n/.exec(content);
  if (!m) return content;
  const norm = (t: string) => t.replace(/[*_`]/g, '').trim().toLowerCase();
  return norm(m[1]) === norm(title) ? content.slice(m[0].length).replace(/^\s*\n/, '') : content;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CanvasItem {
  /** Client-generated or DB id */
  id: string;
  title: string;
  type: 'document' | 'code' | 'html' | 'mermaid';
  language?: string | null;
  content: string;
  version: number;
  /** Last-modified ISO timestamp (DB canvases) — shown in the file list. */
  updatedAt?: string;
  /** Creation stamp — pins the inline canvas card to the answer that made it
   *  (lib/canvas-attach.ts). Streamed canvases stamp the client clock. */
  createdAt?: string;
  /** Transient READ-ONLY preview (ticket 999e3dbe worktree viewer): not a
      persisted canvas — excluded from the file list, and the detail view hides
      every mutation affordance (edit/rename/delete/share/save-to-project). */
  readOnly?: boolean;
}

interface CanvasPanelProps {
  canvases: CanvasItem[];
  activeCanvasId: string | null;
  /** Panel-close affordance (2026-08-31: OPTIONAL — WorkspacePanel owns the
      single close X for every section now; hosts pass nothing). When omitted,
      no X buttons render here. */
  onClose?: () => void;
  onUpdateCanvas: (id: string, content: string, title?: string) => void;
  onDeleteCanvas: (id: string) => void;
  /** One-Digby C5: commit this canvas to the chat's project repo (knowledge branch). */
  onSaveToProject?: (canvas: CanvasItem) => Promise<void>;
  /** File-browser navigation (ticket 59a4454e): select a file (detail view) or null (back to the list). */
  onSelectCanvas: (id: string | null) => void;
  /** When provided, the list view shows a "New file" button (persisted chats only). */
  onCreateCanvas?: () => void;
  /** List heading (2026-09-23 consolidation): the canvases live INSIDE the Files
      tab on every surface, so the list calls itself "Files" by default (2026-10-07: never "Artifacts"). */
  listTitle?: string;
  /**
   * Ticket 19fbd876: REAL-BYTE download for read-only worktree previews. When
   * set, the download button on a readOnly canvas calls this INSTEAD of
   * blobbing the preview's text content — without it, a binary worktree file
   * (which previews as the 415 notice text) downloaded as a mislabeled .txt
   * of that notice. The host fetches the /worktree/raw bytes and names the
   * file from the worktree path. Non-readOnly canvases keep the text blob.
   */
  onDownloadReadOnly?: (canvas: CanvasItem) => Promise<void>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Canvas type metadata lives in canvas-meta.ts (shared with files/page.tsx);
// re-exported here so existing `from './components/CanvasPanel'` imports keep working.
export { TYPE_ICONS, TYPE_LABELS, TYPE_COLORS } from './canvas-meta';

/**
 * Strip markdown code fence markers from code canvas content.
 * AI sometimes wraps code in ```lang...``` even inside [CANVAS] blocks.
 * Belt-and-suspenders: backend strips at parse time, frontend strips at display time.
 */
function stripCodeFences(content: string): string {
  return content
    .replace(/^```[a-zA-Z0-9]*\s*\n?/, '')  // strip opening ```lang
    .replace(/\n?```\s*$/, '')               // strip closing ```
    .trim();
}

// ─── Single Canvas Editor ────────────────────────────────────────────────────
// Digby Frontier (2026-10-06): ONE 56px header — [back] FileText · title ·
// segmented control (Preview / Markdown, Preview / Code, or View / Edit) ·
// Copy · Download · ⋯ (save to folder, share, revoke, delete) · X — over a
// document body padded 40/44/64 with the title in Newsreader 32px.

const HEADER_BTN =
  'flex size-8 flex-shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink disabled:opacity-50';

function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div role="tablist" className="flex flex-shrink-0 items-center rounded-full bg-hover p-[3px]">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-full px-3 py-1 text-[12.5px] font-medium transition-[background-color,color,box-shadow] duration-150',
              on ? 'bg-raised text-ink shadow-(--shadow)' : 'text-ink-3 hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function CanvasEditor({
  canvas,
  onUpdate,
  onBack,
  onDownload,
  downloadBusy,
  onClose,
  menuItems,
  shared,
}: {
  canvas: CanvasItem;
  onUpdate: (content: string, title?: string) => void;
  onBack?: () => void;
  onDownload: () => void;
  downloadBusy?: boolean;
  onClose?: () => void;
  /** Secondary actions (save to folder, share, revoke, delete) for the ⋯ menu. */
  menuItems?: ReactNode;
  /** Shared publicly — a quiet dot on the ⋯ button. */
  shared?: boolean;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(canvas.content);
  const [editTitle, setEditTitle] = useState(canvas.title);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [copied, setCopied] = useState(false);
  // HTML opens on its live preview (the design's "Preview" segment).
  const [htmlPreview, setHtmlPreview] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Read-only previews (worktree files) never enter an edit path.
  const readOnly = !!canvas.readOnly;

  // Keep local state in sync when canvas content changes externally (AI refine)
  useEffect(() => {
    setEditContent(canvas.content);
  }, [canvas.content]);

  useEffect(() => {
    setEditTitle(canvas.title);
  }, [canvas.title]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(canvas.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
      toast.success('Copied to clipboard');
    });
  }, [canvas.content]);

  const handleSave = useCallback(() => {
    onUpdate(editContent, editTitle !== canvas.title ? editTitle : undefined);
    setIsEditing(false);
    toast.success('File saved');
  }, [editContent, editTitle, canvas.title, onUpdate]);

  const handleDiscard = useCallback(() => {
    setEditContent(canvas.content);
    setEditTitle(canvas.title);
    setIsEditing(false);
  }, [canvas.content, canvas.title]);

  // Switching back to the preview saves pending edits (the old Check toggle).
  const setMode = useCallback((mode: 'preview' | 'source') => {
    if (mode === 'source') { if (!isEditing) setIsEditing(true); return; }
    if (isEditing) {
      if (editContent !== canvas.content || editTitle !== canvas.title) handleSave();
      else setIsEditing(false);
    }
  }, [isEditing, editContent, editTitle, canvas.content, canvas.title, handleSave]);

  const Icon = TYPE_ICONS[canvas.type] || FileText;
  const segmented = canvas.type === 'html'
    ? <Segmented value={htmlPreview ? 'preview' : 'code'} options={[{ value: 'preview', label: 'Preview' }, { value: 'code', label: 'Code' }]} onChange={(v) => setHtmlPreview(v === 'preview')} />
    : readOnly ? null
    : canvas.type === 'document'
      ? <Segmented value={isEditing ? 'source' : 'preview'} options={[{ value: 'preview', label: 'Preview' }, { value: 'source', label: 'Markdown' }]} onChange={setMode} />
      : <Segmented value={isEditing ? 'source' : 'preview'} options={[{ value: 'preview', label: 'View' }, { value: 'source', label: 'Edit' }]} onChange={setMode} />;

  const editBody = (
    <div className="h-full flex flex-col">
      <Textarea
        ref={textareaRef}
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        className="flex-1 h-full resize-none rounded-none border-0 bg-transparent font-mono text-[13px] leading-relaxed px-6 py-5 focus-visible:ring-0 focus-visible:ring-offset-0"
        placeholder={canvas.type === 'document' ? 'Start writing...' : undefined}
      />
      <div className="flex items-center gap-2 px-5 py-2.5 border-t border-line flex-shrink-0">
        <Button size="sm" className="h-8 rounded-full px-3.5 text-[12.5px]" onClick={handleSave}>
          <Check className="size-3.5 mr-1" /> Save
        </Button>
        <Button size="sm" variant="ghost" className="h-8 rounded-full px-3.5 text-[12.5px]" onClick={handleDiscard}>
          Discard
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header — 56px, hairline under it. */}
      <div className="flex h-14 flex-shrink-0 items-center gap-2.5 border-b border-line pl-3 pr-2.5">
        {onBack && (
          <button type="button" className={cn(HEADER_BTN, '-mr-1')} onClick={onBack} title="Back to files" aria-label="Back to files">
            <ChevronLeft className="size-4" />
          </button>
        )}
        <Icon className="size-4 flex-shrink-0 text-ink-3" strokeWidth={1.75} aria-label={TYPE_LABELS[canvas.type]} />
        {/* Title — inline rename on click (plain text for read-only previews) */}
        {readOnly ? (
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink" title={canvas.title}>
            {canvas.title}
          </span>
        ) : isEditingTitle ? (
          <Input
            autoFocus
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={() => {
              setIsEditingTitle(false);
              if (editTitle.trim() && editTitle !== canvas.title) {
                onUpdate(canvas.content, editTitle.trim());
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.currentTarget.blur(); }
              if (e.key === 'Escape') { setEditTitle(canvas.title); setIsEditingTitle(false); }
            }}
            className="h-8 min-w-0 flex-1 text-[14px] font-medium"
          />
        ) : (
          <button
            onClick={() => setIsEditingTitle(true)}
            className="min-w-0 flex-1 truncate rounded-md px-0.5 text-left text-[14px] font-medium text-ink transition-colors hover:text-ink-2"
            title="Click to rename"
          >
            {canvas.title}
          </button>
        )}
        {segmented}
        <div className="flex flex-shrink-0 items-center">
          <button type="button" className={HEADER_BTN} onClick={handleCopy} title="Copy to clipboard" aria-label="Copy to clipboard">
            {copied ? <Check className="size-[15px]" /> : <Copy className="size-[15px]" strokeWidth={1.75} />}
          </button>
          <button type="button" className={HEADER_BTN} onClick={onDownload} title="Download file" aria-label="Download file" disabled={downloadBusy}>
            {downloadBusy ? <Loader2 className="size-[15px] animate-spin" /> : <Download className="size-[15px]" strokeWidth={1.75} />}
          </button>
          {menuItems && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={cn(HEADER_BTN, 'relative')} title="More" aria-label="More file actions">
                  <MoreHorizontal className="size-4" />
                  {shared && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-ok" aria-label="Shared publicly" />}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">{menuItems}</DropdownMenuContent>
            </DropdownMenu>
          )}
          {onClose && (
            <button type="button" className={HEADER_BTN} onClick={onClose} title="Close file" aria-label="Close file">
              <X className="size-[17px]" strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>

      {/* Canvas content area */}
      <div className="flex-1 overflow-hidden">
        {/* DOCUMENT: edit textarea OR the rendered document */}
        {canvas.type === 'document' && (
          isEditing ? editBody : (
            <ScrollArea className="h-full">
              <div className="px-6 pt-8 pb-16 sm:px-11 sm:pt-10">
                <h1 className="m-0 font-serif text-[32px] font-normal leading-[1.15] tracking-[-0.015em] text-ink text-balance">{canvas.title}</h1>
                <p className="mt-2.5 mb-7 text-[13.5px] text-ink-3">
                  {[TYPE_LABELS[canvas.type] || 'Document', canvas.version > 1 ? `Version ${canvas.version}` : null, canvas.updatedAt ? `Updated ${absoluteDate(canvas.updatedAt, 'medium')}` : null, readOnly ? 'Read-only' : null].filter(Boolean).join(' · ')}
                </p>
                <CanvasMarkdownContent>
                  {stripLeadingTitle(canvas.content, canvas.title)}
                </CanvasMarkdownContent>
              </div>
            </ScrollArea>
          )
        )}

        {/* CODE / MERMAID: code view OR edit textarea */}
        {(canvas.type === 'code' || canvas.type === 'mermaid') && (
          isEditing ? editBody : (
            <ScrollArea className="h-full">
              <div className="p-4 sm:p-5">
                {canvas.type === 'mermaid' && (
                  <p className="text-[12.5px] text-ink-3 mb-3 flex items-center gap-1.5 flex-wrap">
                    <GitBranch className="size-3 flex-shrink-0" />
                    Copy this diagram code and paste it at{' '}
                    <a href="https://mermaid.live" target="_blank" rel="noopener noreferrer" className="text-ink underline decoration-line-2 underline-offset-[3px]">
                      mermaid.live
                    </a>{' '}
                    to render it.
                  </p>
                )}
                {readOnly && (
                  <p className="mb-3 text-[12px] text-ink-3">Read-only{canvas.language ? ` · ${canvas.language}` : ''}</p>
                )}
                <pre className="rounded-xl border border-line bg-bg-2 p-4 overflow-x-auto font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-all">
                  <code>{stripCodeFences(canvas.content)}</code>
                </pre>
              </div>
            </ScrollArea>
          )
        )}

        {/* HTML: iframe preview OR code view (edit when toggled from code) */}
        {canvas.type === 'html' && (
          htmlPreview ? (
            <iframe
              srcDoc={canvas.content}
              className="w-full h-full border-0 bg-white"
              /* NEVER add allow-same-origin here: srcDoc inherits the digby.example.com
                 origin, so allow-scripts + allow-same-origin would let AI/collab-
                 authored canvas HTML read window.parent.localStorage (the JWT).
                 Scripts still run, just with no access to our origin. */
              sandbox="allow-scripts"
              title="HTML Preview"
            />
          ) : isEditing ? editBody : (
            <ScrollArea className="h-full">
              <div className="p-4 sm:p-5">
                {!readOnly && (
                  <div className="mb-3 flex justify-end">
                    <button type="button" onClick={() => setIsEditing(true)} className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-[12px] text-ink-2 transition-colors hover:border-line-2 hover:bg-hover">
                      <Pencil className="size-3" /> Edit
                    </button>
                  </div>
                )}
                <pre className="rounded-xl border border-line bg-bg-2 p-4 overflow-x-auto text-[13px] font-mono leading-relaxed">
                  <code>{canvas.content}</code>
                </pre>
              </div>
            </ScrollArea>
          )
        )}
      </div>
    </div>
  );
}

// ─── Canvas File List ─────────────────────────────────────────────────────────
// File-browser landing view (ticket 59a4454e): every canvas shows as a file row
// (type icon, title.ext, size, modified date); a row opens the detail view.
// Replaces the old "panel only opens straight into a document" model.

function formatFileSize(content: string): string {
  const bytes = new Blob([content]).size;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function CanvasFileList({
  canvases,
  onSelectCanvas,
  onCreateCanvas,
  onClose,
  listTitle = 'Files',
}: {
  canvases: CanvasItem[];
  onSelectCanvas: (id: string) => void;
  onCreateCanvas?: () => void;
  onClose?: () => void;
  listTitle?: string;
}) {
  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex items-center gap-2 pl-[18px] pr-2.5 pt-4 pb-1.5 flex-shrink-0 text-ink-2">
        <span className="text-[13px] font-medium">{listTitle}</span>
        <span className="text-[12px] text-ink-3 tabular-nums">{canvases.length}</span>
        <div className="ml-auto flex items-center">
          {onCreateCanvas && (
            <button type="button" className={HEADER_BTN} onClick={onCreateCanvas} title="New file" aria-label="New file">
              <Plus className="size-4" strokeWidth={1.75} />
            </button>
          )}
          {onClose && (
            <button type="button" className={HEADER_BTN} onClick={onClose} title="Close panel" aria-label="Close panel">
              <X className="size-[17px]" strokeWidth={1.75} />
            </button>
          )}
        </div>
      </div>
      <ScrollArea className="flex-1">
        {canvases.length === 0 ? (
          <Empty className="gap-2 px-6 py-16 border-none">
            <EmptyHeader>
              <EmptyMedia>
                <FileText className="size-8 text-muted-foreground/40" />
              </EmptyMedia>
              <EmptyDescription className="text-sm text-muted-foreground">No files yet.</EmptyDescription>
              <EmptyDescription className="text-xs text-muted-foreground/70">
                Documents and code Digby creates in this chat appear here as files — markdown rendered, code syntax-highlighted.
              </EmptyDescription>
            </EmptyHeader>
            {onCreateCanvas && (
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={onCreateCanvas}>
                  <Plus className="size-3.5 mr-1.5" /> New file
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <ul className="space-y-px px-2 pb-3">
            {canvases.map((c) => {
              const TypeIcon = TYPE_ICONS[c.type] || FileText;
              const filename = `${sanitizeFilename(c.title)}.${getFileExtension(c.type, c.language)}`;
              return (
                <li key={c.id}>
                  <button
                    onClick={() => onSelectCanvas(c.id)}
                    className="w-full flex items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 hover:bg-hover"
                  >
                    <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-hover text-ink-2">
                      <TypeIcon className="size-4" strokeWidth={1.75} />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[14px] font-medium text-ink truncate">{c.title}</span>
                      <span className="block font-mono text-[11.5px] text-ink-3 truncate">{filename}</span>
                    </span>
                    <span className="flex-shrink-0 text-right">
                      <span className="block text-[12px] text-ink-3 tabular-nums">{formatFileSize(c.content)}</span>
                      <span className="block text-[11px] text-ink-3">{absoluteDate(c.updatedAt, 'medium')}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

// ─── Canvas Panel ─────────────────────────────────────────────────────────────

function CanvasPanel({
  canvases,
  activeCanvasId,
  onClose,
  onUpdateCanvas,
  onDeleteCanvas,
  onSaveToProject,
  onSelectCanvas,
  onCreateCanvas, listTitle = 'Files', onDownloadReadOnly }: CanvasPanelProps) {
  // File-browser routing (ticket 59a4454e): no selection → the file list, not a
  // silent jump into the first document. A stale id (deleted canvas) also lands
  // on the list, which is the honest "that file is gone" surface.
  const activeCanvas = activeCanvasId ? canvases.find(c => c.id === activeCanvasId) : undefined;
  // Read-only previews (worktree files) open in the detail view but are NOT
  // listed files — the list shows persisted canvases only.
  const listedCanvases = canvases.filter(c => !c.readOnly);
  const readOnlyActive = !!activeCanvas?.readOnly;
  const [savingToProject, setSavingToProject] = useState(false);
  const handleSaveToProject = useCallback(async () => {
    if (!activeCanvas || !onSaveToProject || savingToProject) return;
    setSavingToProject(true);
    try { await onSaveToProject(activeCanvas); } finally { setSavingToProject(false); }
  }, [activeCanvas, onSaveToProject, savingToProject]);

  // ── Public sharing: one click → a real web page anyone can open. HTML
  // artifacts run live (sandboxed); everything else renders read-only. Served
  // straight from the DB through the backend — one service for all artifacts.
  const [shared, setShared] = useState<{ url: string } | null>(null);
  const [sharing, setSharing] = useState(false);
  // Honest failure: a failed status fetch must not silently render "not shared".
  const [shareStatusUnknown, setShareStatusUnknown] = useState(false);
  useEffect(() => {
    setShared(null);
    setShareStatusUnknown(false);
    // Read-only previews have no DB canvas row — no share status to fetch.
    if (!activeCanvas || activeCanvas.readOnly) return;
    const id = activeCanvas.id; // guard: a slow status fetch for a PREVIOUS canvas
    let cancelled = false;      // must not mark THIS canvas shared (wrong-URL copy).
    canvasApi.shareStatus(id)
      .then(s => { if (!cancelled && s.shared && s.url) setShared({ url: s.url }); })
      .catch(() => { if (!cancelled) setShareStatusUnknown(true); });
    return () => { cancelled = true; };
  }, [activeCanvas?.id]);
  const absoluteShareUrl = (path: string) => `${window.location.origin}${path}`;
  const handleShare = useCallback(async () => {
    if (!activeCanvas || sharing) return;
    setSharing(true);
    try {
      // Status fetch failed earlier — re-check before creating, so an
      // already-shared artifact copies its existing link instead of re-sharing.
      if (shareStatusUnknown && !shared) {
        try {
          const s = await canvasApi.shareStatus(activeCanvas.id);
          setShareStatusUnknown(false);
          if (s.shared && s.url) {
            setShared({ url: s.url });
            await navigator.clipboard.writeText(absoluteShareUrl(s.url));
            toast.success('Public link copied — anyone with it can view this file');
            return;
          }
        } catch {
          toast.error('Could not check the share status — try again.');
          return;
        }
      }
      if (shared) {
        await navigator.clipboard.writeText(absoluteShareUrl(shared.url));
        toast.success('Public link copied — anyone with it can view this file');
      } else {
        const r = await canvasApi.share(activeCanvas.id);
        setShared({ url: r.url });
        await navigator.clipboard.writeText(absoluteShareUrl(r.url)).catch(() => {});
        toast.success('Shared publicly — link copied. Anyone with it can view this file.');
      }
    } catch { toast.error('Could not share'); } finally { setSharing(false); }
  }, [activeCanvas, shared, sharing, shareStatusUnknown]);
  const handleRevokeShare = useCallback(async () => {
    if (!activeCanvas || !shared) return;
    try { await canvasApi.revokeShare(activeCanvas.id); setShared(null); toast.message('Public link revoked'); }
    catch { toast.error('Could not revoke'); }
  }, [activeCanvas, shared]);

  // Ticket 19fbd876: a READ-ONLY worktree preview's content is the fetched
  // text — for a binary file that is the 415 inline NOTICE, not the file's
  // bytes, so blobbing it hands the owner a mislabeled .txt of the notice.
  // When the host provides a real-byte download, use it for readOnly canvases.
  const [downloadBusy, setDownloadBusy] = useState(false);
  const handleDownload = useCallback(async () => {
    if (!activeCanvas) return;
    if (activeCanvas.readOnly && onDownloadReadOnly) {
      if (downloadBusy) return;
      setDownloadBusy(true);
      try { await onDownloadReadOnly(activeCanvas); }
      catch { toast.error('Could not download the file — try again.'); }
      finally { setDownloadBusy(false); }
      return;
    }
    const ext = getFileExtension(activeCanvas.type, activeCanvas.language);
    const filename = `${sanitizeFilename(activeCanvas.title)}.${ext}`;
    const blob = new Blob([activeCanvas.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${filename}`);
  }, [activeCanvas, onDownloadReadOnly, downloadBusy]);
  if (!activeCanvas) {
    return (
      <CanvasFileList
        canvases={listedCanvases}
        onSelectCanvas={onSelectCanvas}
        onCreateCanvas={onCreateCanvas}
        onClose={onClose}
        listTitle={listTitle}
      />
    );
  }
  const menuItems = readOnlyActive ? undefined : (
    <>
      {onSaveToProject && (
        <DropdownMenuItem onClick={() => void handleSaveToProject()} disabled={savingToProject}>
          {savingToProject ? <Loader2 className="size-4 animate-spin" /> : <GitBranch className="size-4" />}
          Save to folder
        </DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={() => void handleShare()} disabled={sharing}>
        {sharing ? <Loader2 className="size-4 animate-spin" /> : <Share2 className="size-4" />}
        {shared ? 'Copy public link' : 'Share publicly'}
      </DropdownMenuItem>
      {shared && (
        <DropdownMenuItem onClick={() => void handleRevokeShare()}>
          <Link2Off className="size-4" />
          Revoke the public link
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={() => onDeleteCanvas(activeCanvas.id)}>
        <Trash2 className="size-4" />
        Delete
      </DropdownMenuItem>
    </>
  );

  return (
    <div className="flex flex-col h-full bg-background">
      {/* One header (Digby Frontier) — the editor owns it; the panel feeds
          back-to-files, download, the ⋯ actions and the optional close. */}
      <CanvasEditor
        key={activeCanvas.id}
        canvas={activeCanvas}
        onUpdate={(content, title) => onUpdateCanvas(activeCanvas.id, content, title)}
        onBack={() => onSelectCanvas(null)}
        onDownload={() => void handleDownload()}
        downloadBusy={downloadBusy}
        onClose={onClose}
        menuItems={menuItems}
        shared={!!shared}
      />
    </div>
  );
}

// Memoized: with stable props (canvases, activeCanvasId, and useCallback'd handlers) this skips
// re-rendering — and re-parsing the canvas markdown — on every keystroke in the chat input, which
// was the cause of typing lag whenever a canvas was open.
export default memo(CanvasPanel);
