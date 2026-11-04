'use client';

/**
 * ChatFilesSection — per-chat Files panel section (ticket 57ef1b9f PR2).
 *
 * ONE list of the ACTIVE chat's files (owner 2026-10-07: "not artifacts it
 * should just all be files") — newest first, no subsections, one empty state:
 *   - uploads          — ChatFile rows: user uploads persisted by the PR1
 *                        backend (GET /chats/:chatId/files). Uploads only BEGIN
 *                        persisting from the PR1 deploy (2026-08-25 ~20:32Z),
 *                        so older chats legitimately render the empty state.
 *   - generated files  — GeneratedFile rows (the pre-existing document-tools
 *                        system, same source as the Files page) filtered to
 *                        this chatId SERVER-side (?chatId=, 2026-08-31 — the
 *                        old client-side filter over the 200-row user-wide
 *                        list lost attribution for older rows).
 *   - documents        — the chat's in-chat documents (canvases: markdown,
 *                        code, html, diagrams), passed in by the host as
 *                        `docs`; a row click opens it in the panel editor.
 *
 * The connected wrapper fetches on chatId change and on `refreshKey` bumps
 * (parents bump the key when a message send completes, so an upload the user
 * just sent appears). ChatFilesSectionView is the pure presentational half —
 * exported so the vitest SSR idiom (renderToStaticMarkup, same as
 * markdown-content.test.tsx) can render list/empty/error states directly.
 *
 * Byte routes are Bearer-only (no query-token variant), so download + preview
 * ride chatFilesApi's raw-fetch Bearer helpers — never a bare <a href>.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { relativeTimeLong } from '@/lib/relative-time';
import { toast } from 'sonner';
import {
  Download,
  Eye,
  FileDown,
  FileJson,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Plus,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { cn } from '@/lib/utils';
import {
  chatFilesApi,
  filesApi,
  type ChatFileMeta,
  type GeneratedFileMeta,
} from '@/lib/api/crossmodel';
import { AuthedFileImage, AuthedImageLightbox } from '@/components/ui/custom/prompt/file-link-card';
import { FilePreviewModal, previewKindForMime } from './file-preview-modal';
import type { CanvasItem } from './CanvasPanel';
import { TYPE_ICONS, getFileExtension, sanitizeFilename } from './canvas-meta';

// ─── Display helpers (mirror files/page.tsx + the attachment-chip icon set) ──

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Middle-truncate long filenames — the tail keeps the extension legible. */
function truncateMiddle(name: string, max = 36): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}

/** Mime essence — parameters/case stripped, mirroring the backend's rule. */
const mimeEssence = (m: string) => (m || '').split(';', 1)[0].trim().toLowerCase();

/**
 * Preview gate — anything the FilePreviewModal has a kind for (images, pdf,
 * text/*, json/xml, and NOW docx/xlsx via the backend /preview-text route).
 * The scripting-capable essences (html/svg) are excluded by the kind gate
 * itself (B1 stored-XSS: a blob: URL re-serve carries no sandbox header).
 * Compared on the ESSENCE, mirroring the backend.
 */
function canPreview(mimeType: string): boolean {
  return previewKindForMime(mimeType) !== null;
}

const ICON_CLS = 'size-4 flex-shrink-0';

/** Upload icon by mime essence (attachment chips: image vs document). */
function UploadFileIcon({ mimeType }: { mimeType: string }) {
  const m = mimeEssence(mimeType);
  if (m.startsWith('image/')) return <ImageIcon className={cn(ICON_CLS, 'text-ink-3')} />;
  if (m === 'application/pdf') return <FileDown className={cn(ICON_CLS, 'text-destructive')} />;
  if (m.includes('spreadsheet') || m === 'text/csv') return <FileSpreadsheet className={cn(ICON_CLS, 'text-success')} />;
  if (m === 'application/json' || m.endsWith('+json')) return <FileJson className={cn(ICON_CLS, 'text-warn-ink')} />;
  return <FileText className={cn(ICON_CLS, 'text-ink-3')} />;
}

/** Generated-file icon by format — mirrors files/page.tsx GeneratedFileIcon. */
function GeneratedFileIcon({ format }: { format: string }) {
  // generate_image rows (2026-09-24): format is the sniffed extension.
  if (format === 'png' || format === 'jpg' || format === 'jpeg' || format === 'webp') return <ImageIcon className={cn(ICON_CLS, 'text-ink-3')} />;
  if (format === 'xlsx' || format === 'csv') return <FileSpreadsheet className={cn(ICON_CLS, 'text-success')} />;
  if (format === 'pdf') return <FileDown className={cn(ICON_CLS, 'text-destructive')} />;
  if (format === 'json') return <FileJson className={cn(ICON_CLS, 'text-warn-ink')} />;
  return <FileText className={cn(ICON_CLS, 'text-ink-3')} />;
}

// ─── Row actions (toast on failure, same as the Files page handlers) ─────────

async function handleDownloadUpload(file: ChatFileMeta) {
  try {
    await chatFilesApi.download(file.id, file.filename);
  } catch {
    toast.error('Failed to download file');
  }
}

async function handleDownloadGenerated(file: GeneratedFileMeta) {
  try {
    await filesApi.downloadGenerated(file.id, file.filename);
  } catch {
    toast.error('Failed to download file');
  }
}

// ─── Pure view (exported for tests) ──────────────────────────────────────────

export type ChatFilesSectionStatus = 'idle' | 'loading' | 'error' | 'ready';

function UploadRow({ file, onPreview, onDelete }: { file: ChatFileMeta; onPreview: (file: ChatFileMeta) => void; onDelete?: (file: ChatFileMeta) => void }) {
  const rel = relativeTimeLong(file.createdAt);
  return (
    <li className="group flex items-center gap-3 py-2.5">
      {/* Image rows render a real thumbnail (authed, B1-gated, self-zooming —
          its click opens the shared ImageLightbox); other types keep the icon.
          The kind gate (not raw isBlobRenderableImage) also excludes heic/heif,
          which browsers cannot decode. */}
      {previewKindForMime(file.mimeType) === 'image' ? (
        <AuthedFileImage
          target={{ kind: 'chat-file', id: file.id, route: 'inline' }}
          alt={file.filename}
          className="size-10 flex-shrink-0 rounded-md object-cover border"
        />
      ) : (
        <UploadFileIcon mimeType={file.mimeType} />
      )}
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium text-foreground truncate" title={file.filename}>
          {truncateMiddle(file.filename)}
        </span>
        <span className="block text-[11px] text-muted-foreground truncate">
          {formatSize(file.sizeBytes)}{rel ? ` · ${rel}` : ''}
        </span>
      </span>
      <span className="flex items-center gap-0.5 flex-shrink-0 opacity-60 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {canPreview(file.mimeType) && (
          <Button
            variant="ghost" size="icon" className="size-7" title="Preview"
            onClick={() => onPreview(file)}
          >
            <Eye className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost" size="icon" className="size-7" title="Download file"
          onClick={() => void handleDownloadUpload(file)}
        >
          <Download className="size-3.5" />
        </Button>
        {onDelete && (
          <Button
            variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive" title="Delete file"
            onClick={() => onDelete(file)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </span>
    </li>
  );
}

function GeneratedRow({ file, onPreview }: { file: GeneratedFileMeta; onPreview: (file: GeneratedFileMeta) => void }) {
  const rel = relativeTimeLong(file.createdAt);
  // Generated IMAGES (generate_image, 2026-09-24): the same size-10 authed
  // thumbnail UploadRow renders (B1-gated on the fetched mime, self-zooming),
  // fetched from the generated file's INLINE route; documents keep the icon.
  const isImage = previewKindForMime(file.mimeType) === 'image';
  return (
    <li className="group flex items-center gap-3 py-2.5">
      {isImage ? (
        <AuthedFileImage
          target={{ kind: 'generated', id: file.id, route: 'inline' }}
          alt={file.filename}
          className="size-10 flex-shrink-0 rounded-md object-cover border"
        />
      ) : (
        <GeneratedFileIcon format={file.format} />
      )}
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-2 min-w-0">
          <span className="block text-sm font-medium text-foreground truncate" title={file.filename}>
            {truncateMiddle(file.filename)}
          </span>
          <Badge variant="outline" className="text-[10px] uppercase py-0 h-4 px-1.5 flex-shrink-0">
            {file.format}
          </Badge>
        </span>
        <span className="block text-[11px] text-muted-foreground truncate">
          {formatSize(file.size)}{rel ? ` · ${rel}` : ''}
        </span>
      </span>
      <span className="flex items-center gap-0.5 flex-shrink-0 opacity-60 md:opacity-0 md:group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {isImage && (
          <Button
            variant="ghost" size="icon" className="size-7" title="Preview"
            onClick={() => onPreview(file)}
          >
            <Eye className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost" size="icon" className="size-7" title="Download file"
          onClick={() => void handleDownloadGenerated(file)}
        >
          <Download className="size-3.5" />
        </Button>
      </span>
    </li>
  );
}

function DocRow({ doc, onOpen }: { doc: CanvasItem; onOpen?: (id: string) => void }) {
  const TypeIcon = TYPE_ICONS[doc.type] || FileText;
  const filename = `${sanitizeFilename(doc.title)}.${getFileExtension(doc.type, doc.language)}`;
  const stamp = doc.updatedAt ?? doc.createdAt;
  const rel = stamp ? relativeTimeLong(stamp) : '';
  const bytes = new Blob([doc.content]).size;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen?.(doc.id)}
        className="w-full flex items-center gap-3 py-2.5 text-left rounded-md transition-colors hover:bg-hover -mx-1.5 px-1.5"
        title={`Open ${filename}`}
      >
        <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-md border bg-hover text-ink-2">
          <TypeIcon className="size-4" strokeWidth={1.75} />
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2 min-w-0">
            <span className="block text-sm font-medium text-foreground truncate">{doc.title}</span>
            <Badge variant="outline" className="text-[10px] uppercase py-0 h-4 px-1.5 flex-shrink-0">
              {getFileExtension(doc.type, doc.language)}
            </Badge>
          </span>
          <span className="block text-[11px] text-muted-foreground truncate">
            {formatSize(bytes)}{rel ? ` · ${rel}` : ''}
          </span>
        </span>
      </button>
    </li>
  );
}

type FileEntry =
  | { kind: 'upload'; at: number; file: ChatFileMeta }
  | { kind: 'generated'; at: number; file: GeneratedFileMeta }
  | { kind: 'doc'; at: number; doc: CanvasItem };

const ts = (iso?: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : 0; };

export function ChatFilesSectionView({
  uploads,
  generated,
  status,
  onRetry,
  onDeleteFile,
  docs = [],
  onOpenDoc,
  onNewFile,
  className,
}: {
  uploads: ChatFileMeta[];
  generated: GeneratedFileMeta[];
  /** The chat's in-chat documents (canvases) — listed as files beside the rest. */
  docs?: CanvasItem[];
  /** Open a document in the panel editor. */
  onOpenDoc?: (id: string) => void;
  /** "New file" (persisted chats only) — omitted ⇒ no button. */
  onNewFile?: () => void;
  status: ChatFilesSectionStatus;
  onRetry?: () => void;
  /** Delete an upload (uploader-only backend route). Rows hide the trash when absent. */
  onDeleteFile?: (file: ChatFileMeta) => void;
  /** Root sizing — default fills the panel tab; embedded uses pass e.g. max-h-72. */
  className?: string;
}) {
  // In-panel preview modal (FilePreviewModal): set by a row's Preview action.
  // SSR tests render with no clicks, so the modal never appears in static
  // markup — same collapsed-first-render discipline as ImageLightbox.
  const [previewFile, setPreviewFile] = useState<ChatFileMeta | null>(null);
  // Generated IMAGE preview (2026-09-24): the row's Preview action opens the
  // shared lightbox on the file's inline route (authed fetch, B1-gated).
  const [previewGenerated, setPreviewGenerated] = useState<GeneratedFileMeta | null>(null);
  // Delete confirm (AlertDialog): set by a row's trash action.
  const [deletingFile, setDeletingFile] = useState<ChatFileMeta | null>(null);
  if (status === 'loading') {
    return (
      <div className={cn('flex items-center justify-center py-10', className ?? 'h-full')}>
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className={className}>
        <LoadErrorState message="Couldn't load this chat's files." onRetry={onRetry} />
      </div>
    );
  }
  if (status === 'idle') {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-16 text-center', className ?? 'h-full')}>
        <Paperclip className="size-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">Open a chat to see its files.</p>
      </div>
    );
  }
  const entries: FileEntry[] = [
    ...uploads.map((file): FileEntry => ({ kind: 'upload', at: ts(file.createdAt), file })),
    ...generated.map((file): FileEntry => ({ kind: 'generated', at: ts(file.createdAt), file })),
    ...docs.filter(d => !d.readOnly).map((doc): FileEntry => ({ kind: 'doc', at: ts(doc.updatedAt ?? doc.createdAt), doc })),
  ].sort((a, b) => b.at - a.at);
  return (
    <div className={cn('overflow-y-auto', className ?? 'h-full')} data-files-list>
      {/* ONE list (owner 2026-10-07): uploads, files Digby generated and the
          chat's documents together, newest first — no "Artifacts", no
          per-kind subsections, one empty state. */}
      {/* The panel tab already says "Files" — no second "Files" heading, and
          no "0" count over the empty state (prod walkthrough 2026-10-07). */}
      {entries.length > 0 && (
        <div className="flex items-center gap-2 px-3 sm:px-4 pt-3 pb-1">
          <span className="text-[12px] text-ink-3 tabular-nums" data-files-count>
            {entries.length} {entries.length === 1 ? 'file' : 'files'}
          </span>
          {onNewFile && (
            <Button variant="ghost" size="icon" className="ml-auto size-7 text-ink-3" title="New file" aria-label="New file" onClick={onNewFile}>
              <Plus className="size-4" strokeWidth={1.75} />
            </Button>
          )}
        </div>
      )}
      <section className="px-3 sm:px-4 pb-3">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Paperclip className="size-7 text-ink-3/60" />
            <p className="text-sm text-ink-2">No files yet</p>
            <p className="text-xs text-ink-3 max-w-[22rem]">
              Files you attach and anything Digby creates in this chat — documents, code, spreadsheets, images — appear here.
            </p>
            {onNewFile && (
              <Button variant="outline" size="sm" className="mt-1" onClick={onNewFile}>
                <Plus className="size-3.5 mr-1.5" /> New file
              </Button>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map(e => e.kind === 'upload' ? (
              <UploadRow
                key={`u:${e.file.id}`}
                file={e.file}
                onPreview={setPreviewFile}
                onDelete={onDeleteFile ? setDeletingFile : undefined}
              />
            ) : e.kind === 'generated' ? (
              <GeneratedRow key={`g:${e.file.id}`} file={e.file} onPreview={setPreviewGenerated} />
            ) : (
              <DocRow key={`d:${e.doc.id}`} doc={e.doc} onOpen={onOpenDoc} />
            ))}
          </ul>
        )}
      </section>

      {/* In-panel preview — images/pdf/text/docx/xlsx, Esc/backdrop/X close. */}
      {previewFile && <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}

      {/* Generated image preview (2026-09-24) — the shared lightbox on the
          file's inline route; mounted only after the Preview click. */}
      {previewGenerated && (
        <AuthedImageLightbox
          target={{ kind: 'generated', id: previewGenerated.id, route: 'inline' }}
          alt={previewGenerated.filename}
          onClose={() => setPreviewGenerated(null)}
        />
      )}

      {/* Delete confirm — the upload is gone for good; the chat stays. */}
      <AlertDialog open={!!deletingFile} onOpenChange={open => !open && setDeletingFile(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {deletingFile?.filename ?? 'the file'}. The chat it was sent in remains.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => {
                if (deletingFile && onDeleteFile) onDeleteFile(deletingFile);
                setDeletingFile(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Connected wrapper ────────────────────────────────────────────────────────

function ChatFilesSection({
  chatId,
  refreshKey = 0,
  docs,
  onOpenDoc,
  onNewFile,
  className,
}: {
  chatId: string | null;
  /** The chat's documents (canvases), listed with the rest of the files. */
  docs?: CanvasItem[];
  onOpenDoc?: (id: string) => void;
  onNewFile?: () => void;
  /** Bump to refetch (e.g. when a message send completes). */
  refreshKey?: number;
  className?: string;
}) {
  const [status, setStatus] = useState<ChatFilesSectionStatus>(chatId ? 'loading' : 'idle');
  const [uploads, setUploads] = useState<ChatFileMeta[]>([]);
  const [generated, setGenerated] = useState<GeneratedFileMeta[]>([]);
  const [reloadTick, setReloadTick] = useState(0);
  // Chat whose data last loaded successfully — a refreshKey bump for the SAME
  // chat refreshes silently (no spinner flash / no list wipe on a transient
  // failure); a chat SWITCH resets to the loading state so a previous chat's
  // rows never show under the new one.
  const loadedChatRef = useRef<string | null>(null);

  useEffect(() => {
    if (!chatId) {
      loadedChatRef.current = null;
      setUploads([]);
      setGenerated([]);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    if (loadedChatRef.current !== chatId) {
      setUploads([]);
      setGenerated([]);
      setStatus('loading');
    }
    Promise.all([
      chatFilesApi.listForChat(chatId),
      filesApi.listGenerated(chatId), // server-side chat filter (2026-08-31)
    ])
      .then(([files, chatGenerated]) => {
        if (cancelled) return;
        loadedChatRef.current = chatId;
        setUploads(files);
        setGenerated(chatGenerated);
        setStatus('ready');
      })
      .catch(() => {
        // Honest failure on first load; a failed silent refresh keeps the
        // last good list (never render the empty state over an errored fetch).
        if (!cancelled) setStatus(prev => (prev === 'ready' ? prev : 'error'));
      });
    return () => { cancelled = true; };
  }, [chatId, refreshKey, reloadTick]);

  const retry = useCallback(() => setReloadTick(t => t + 1), []);

  // Uploader-only DELETE (backend gate mirrors deleteGeneratedFile): drop the
  // row from state on success, toast honestly either way.
  const deleteUpload = useCallback(async (file: ChatFileMeta) => {
    try {
      await chatFilesApi.delete(file.id);
      setUploads(prev => prev.filter(f => f.id !== file.id));
      toast.success('File deleted');
    } catch {
      toast.error('Failed to delete file');
    }
  }, []);

  return (
    <ChatFilesSectionView
      uploads={uploads}
      generated={generated}
      status={status}
      onRetry={retry}
      onDeleteFile={deleteUpload}
      docs={docs}
      onOpenDoc={onOpenDoc}
      onNewFile={onNewFile}
      className={className}
    />
  );
}

// Memoized: parents re-render on every composer keystroke — with stable
// props (chatId, refreshKey, the docs array + callbacks) this skips re-rendering the list.
export default memo(ChatFilesSection);
