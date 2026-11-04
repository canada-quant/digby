'use client';

import { useState, useEffect, useCallback } from 'react';
import { absoluteDate } from '@/lib/relative-time';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { toast } from 'sonner';
import {
  FileText,
  FileSpreadsheet,
  FileDown,
  FileJson,
  Globe,
  Loader2,
  Trash2,
  FolderOpen,
  MessageSquare,
  ExternalLink,
  LayoutTemplate,
  Download,
  Eye,
  Image as ImageIcon,
} from 'lucide-react';
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
import { authApi } from '@/lib/auth';
import { isDefinitiveAuthFailure } from '@/lib/api-client';
import { filesApi, canvasApi, chatFilesApi, type ProjectDocument, type CanvasDocumentWithChat, type GeneratedFileMeta, type ChatFileMeta } from '@/lib/api/crossmodel';
import { AuthedFileImage, AuthedImageLightbox } from '@/components/ui/custom/prompt/file-link-card';
import { FilePreviewModal, previewKindForMime } from '../components/file-preview-modal';
import { DocStatusBadge, CanvasTypeBadge } from '../components/badges';
import { TYPE_ICONS, TYPE_COLORS } from '../components/canvas-meta';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { PageBackButton } from '@/components/ui/page-back-button';

function SourceBadge({ source }: { source: 'knowledge' | 'chat_upload' | 'gmail_attachment' | string }) {
  if (source === 'chat_upload') return (
    <Badge variant="outline" className="text-[10px] text-ink border-line gap-1 py-0 h-4 px-1.5">
      <MessageSquare className="size-2" />
      Chat
    </Badge>
  );
  if (source === 'gmail_attachment') return (
    <Badge variant="outline" className="text-[10px] text-ink border-line gap-1 py-0 h-4 px-1.5">
      <MessageSquare className="size-2" />
      Gmail
    </Badge>
  );
  return (
    <Badge variant="outline" className="text-[10px] text-brand border-brand-pale gap-1 py-0 h-4 px-1.5">
      <FolderOpen className="size-2" />
      Knowledge
    </Badge>
  );
}

/** Format-appropriate icon for a generated file. */
function GeneratedFileIcon({ format }: { format: string }) {
  // generate_image rows (2026-09-24): format is the sniffed extension.
  if (format === 'png' || format === 'jpg' || format === 'jpeg' || format === 'webp') return <ImageIcon className="size-4 text-brand-accent flex-shrink-0" />;
  if (format === 'xlsx' || format === 'csv') return <FileSpreadsheet className="size-4 text-success flex-shrink-0" />;
  if (format === 'pdf') return <FileDown className="size-4 text-destructive flex-shrink-0" />;
  if (format === 'json') return <FileJson className="size-4 text-warn-ink flex-shrink-0" />;
  return <FileText className="size-4 text-brand-accent flex-shrink-0" />;
}

/** Mime-essence icon for a chat upload (mirrors ChatFilesSection's set). */
function UploadFileTypeIcon({ mimeType }: { mimeType: string }) {
  const m = (mimeType || '').split(';', 1)[0].trim().toLowerCase();
  if (m === 'application/pdf') return <FileDown className="size-4 text-destructive flex-shrink-0" />;
  if (m.includes('spreadsheet') || m === 'text/csv') return <FileSpreadsheet className="size-4 text-success flex-shrink-0" />;
  if (m === 'application/json' || m.endsWith('+json')) return <FileJson className="size-4 text-warn-ink flex-shrink-0" />;
  return <FileText className="size-4 text-brand-accent flex-shrink-0" />;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function FilesPage() {
  const router = useRouter();

  // Documents (RAG / uploads)
  const [documents, setDocuments] = useState<ProjectDocument[]>([]);
  const [canvases, setCanvases] = useState<CanvasDocumentWithChat[]>([]);
  const [generatedFiles, setGeneratedFiles] = useState<GeneratedFileMeta[]>([]);
  // Chat uploads (ChatFile rows across ALL chats — images included, 2026-08-31)
  const [chatUploads, setChatUploads] = useState<(ChatFileMeta & { chatId: string })[]>([]);
  const [previewUpload, setPreviewUpload] = useState<ChatFileMeta | null>(null);
  // Generated IMAGE preview (2026-09-24): Preview on a generated image row
  // opens the shared lightbox on the file's inline route (authed, B1-gated).
  const [previewGenerated, setPreviewGenerated] = useState<GeneratedFileMeta | null>(null);
  const [loading, setLoading] = useState(true);
  // Per-section error + retry flags: one failed fetch degrades only its own
  // section (inline LoadErrorState + Retry) instead of blocking the page.
  const [docsError, setDocsError] = useState(false);
  const [docsRetrying, setDocsRetrying] = useState(false);
  const [cvsError, setCvsError] = useState(false);
  const [cvsRetrying, setCvsRetrying] = useState(false);
  const [generatedError, setGeneratedError] = useState(false);
  const [generatedRetrying, setGeneratedRetrying] = useState(false);
  const [uploadsError, setUploadsError] = useState(false);
  const [uploadsRetrying, setUploadsRetrying] = useState(false);

  // Delete confirmation
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [deletingCanvasId, setDeletingCanvasId] = useState<string | null>(null);
  const [deletingGeneratedId, setDeletingGeneratedId] = useState<string | null>(null);
  const [deletingUploadId, setDeletingUploadId] = useState<string | null>(null);

  // Source filter for docs
  const [filterSource, setFilterSource] = useState<'all' | 'knowledge' | 'chat_upload'>('all');
  const [filterProject, setFilterProject] = useState<string | 'all' | 'none'>('all');

  // Tab: 'files' ("Uploads") | 'canvases' ("Created in chats") — both are files to the user (2026-10-07: never "Artifacts" / "canvases")
  const [activeTab, setActiveTab] = useState<'files' | 'canvases'>('files');

  // Auth guard
  useEffect(() => {
    authApi.getCurrentUser().catch((err) => {
      // 05303f58: bounce only on a definitive 401 (refresh already failed) —
      // a network blip/5xx keeps the token and leaves the page's load state.
      if (isDefinitiveAuthFailure(err)) router.push('/login');
      else console.warn('getCurrentUser failed (non-auth) — staying put', err);
    });
  }, []);

  // Each loader clears its own error flag at start and swallows failures into
  // it — never render "No files yet" over an errored fetch (honest failure).
  const loadDocs = useCallback(async () => {
    setDocsError(false);
    setDocsRetrying(true);
    try {
      setDocuments(await filesApi.listAll());
    } catch {
      setDocsError(true);
    } finally {
      setDocsRetrying(false);
    }
  }, []);

  const loadCanvases = useCallback(async () => {
    setCvsError(false);
    setCvsRetrying(true);
    try {
      setCanvases(await canvasApi.listAll());
    } catch {
      setCvsError(true);
    } finally {
      setCvsRetrying(false);
    }
  }, []);

  const loadGenerated = useCallback(async () => {
    setGeneratedError(false);
    setGeneratedRetrying(true);
    try {
      setGeneratedFiles(await filesApi.listGenerated());
    } catch {
      setGeneratedError(true);
    } finally {
      setGeneratedRetrying(false);
    }
  }, []);

  const loadUploads = useCallback(async () => {
    setUploadsError(false);
    setUploadsRetrying(true);
    try {
      setChatUploads(await chatFilesApi.listAll());
    } catch {
      setUploadsError(true);
    } finally {
      setUploadsRetrying(false);
    }
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      // The loaders never reject (per-section flags above) — a rejection here
      // would be a bug, but the finally still guarantees the spinner clears.
      await Promise.all([loadDocs(), loadCanvases(), loadGenerated(), loadUploads()]);
    } finally {
      setLoading(false);
    }
  }, [loadDocs, loadCanvases, loadGenerated, loadUploads]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleDeleteDoc = useCallback(async (docId: string) => {
    setDeletingDocId(null);
    try {
      await filesApi.deleteDocument(docId);
      setDocuments(prev => prev.filter(d => d.id !== docId));
      toast.success('File deleted');
    } catch {
      toast.error('Failed to delete file');
    }
  }, []);

  const handleDeleteCanvas = useCallback(async (canvasId: string) => {
    setDeletingCanvasId(null);
    try {
      await canvasApi.delete(canvasId);
      setCanvases(prev => prev.filter(c => c.id !== canvasId));
      toast.success('File deleted');
    } catch {
      toast.error('Failed to delete file');
    }
  }, []);

  const handleDeleteGenerated = useCallback(async (id: string) => {
    setDeletingGeneratedId(null);
    try {
      await filesApi.deleteGenerated(id);
      setGeneratedFiles(prev => prev.filter(f => f.id !== id));
      toast.success('File deleted');
    } catch {
      toast.error('Failed to delete file');
    }
  }, []);

  const handleDeleteUpload = useCallback(async (id: string) => {
    setDeletingUploadId(null);
    try {
      await chatFilesApi.delete(id);
      setChatUploads(prev => prev.filter(f => f.id !== id));
      toast.success('File deleted');
    } catch {
      toast.error('Failed to delete file');
    }
  }, []);

  const handleDownloadUpload = useCallback(async (file: ChatFileMeta) => {
    try {
      await chatFilesApi.download(file.id, file.filename);
    } catch {
      toast.error('Failed to download file');
    }
  }, []);

  const handleDownloadGenerated = useCallback(async (file: GeneratedFileMeta) => {
    try {
      await filesApi.downloadGenerated(file.id, file.filename);
    } catch {
      toast.error('Failed to download file');
    }
  }, []);

  // Derived project list for filter pills
  const projects = Array.from(
    new Map(
      documents
        .filter(d => d.project)
        .map(d => [d.project!.id, d.project!])
    ).values()
  );

  const hasChatUploads = documents.some(d => d.source === 'chat_upload');
  const hasKnowledge   = documents.some(d => d.source !== 'chat_upload');

  const filteredDocs = documents.filter(d => {
    // 'knowledge' filter = everything project-filed (knowledge + gmail_attachment,
    // 99145890 F7 — the pill's count says `!== 'chat_upload'`, so the list must too).
    const sourceMatch   = filterSource === 'all' || (filterSource === 'knowledge' ? d.source !== 'chat_upload' : d.source === filterSource);
    const projectMatch  =
      filterProject === 'all' ||
      (filterProject === 'none' && !d.project) ||
      d.project?.id === filterProject;
    return sourceMatch && projectMatch;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    // h-dvh + internal scroll: globals.css disables body scroll app-wide, so a
    // min-h-screen root has no scroll container and everything below the fold
    // is unreachable (same bug class as app/login/page.tsx). The root IS the
    // scroll container so the sticky header sticks inside it; dialogs portal out.
    <div className="h-dvh overflow-y-auto bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 sticky top-0 z-10" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3 min-w-0">
          <PageBackButton onClick={() => router.push('/')} label="Back to chats" />
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-base">Files</h1>
            <p className="text-xs text-muted-foreground truncate">All your files across Digby chats and folders</p>
          </div>
          <span className="hidden sm:inline text-sm text-muted-foreground whitespace-nowrap">{docsError ? '—' : documents.length} uploaded · {cvsError ? '—' : canvases.length} created in chats</span>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="max-w-4xl mx-auto px-4 py-6 space-y-4 outline-none">

        {/* ── Tab switcher ── */}
        <div className="flex gap-1 rounded-lg border p-1 bg-muted/40 w-fit max-w-full">
          <button
            onClick={() => setActiveTab('files')}
            className={`px-3 py-2 min-h-10 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
              activeTab === 'files'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <FileText className="size-3.5" />
            Uploads
            {!docsError && documents.length > 0 && (
              <span className="text-[10px] text-muted-foreground">({documents.length})</span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('canvases')}
            className={`px-3 py-2 min-h-10 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
              activeTab === 'canvases'
                ? 'bg-background shadow-sm text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <LayoutTemplate className="size-3.5" />
            Created in chats
            {!cvsError && canvases.length > 0 && (
              <span className="text-[10px] text-muted-foreground">({canvases.length})</span>
            )}
          </button>
        </div>

        {/* ═══ FILES TAB ═══ */}
        {activeTab === 'files' && (
          <>
            {/* Source filter pills (hidden while the docs fetch is errored — bogus pills over an outage) */}
            {!docsError && (hasChatUploads && hasKnowledge) && (
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setFilterSource('all')}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                    filterSource === 'all'
                      ? 'bg-foreground text-background border-foreground'
                      : 'hover:bg-muted border-transparent'
                  }`}
                >
                  All ({documents.length})
                </button>
                <button
                  onClick={() => setFilterSource('chat_upload')}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border flex items-center gap-1 ${
                    filterSource === 'chat_upload'
                      ? 'bg-send text-send-ink border-send'
                      : 'hover:bg-muted border-transparent'
                  }`}
                >
                  <MessageSquare className="size-3" />
                  Chat uploads ({documents.filter(d => d.source === 'chat_upload').length})
                </button>
                <button
                  onClick={() => setFilterSource('knowledge')}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border flex items-center gap-1 ${
                    filterSource === 'knowledge'
                      ? 'bg-brand-accent text-brand-foreground border-brand-accent'
                      : 'hover:bg-muted border-transparent'
                  }`}
                >
                  <FolderOpen className="size-3" />
                  Project knowledge ({documents.filter(d => d.source !== 'chat_upload').length})
                </button>
              </div>
            )}

            {/* Project filter pills */}
            {!docsError && projects.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => setFilterProject('all')}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                    filterProject === 'all'
                      ? 'bg-brand-accent text-brand-foreground border-brand-accent'
                      : 'hover:bg-muted border-transparent'
                  }`}
                >
                  All projects
                </button>
                {projects.map(p => (
                  <button
                    key={p.id}
                    onClick={() => setFilterProject(p.id)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border flex items-center gap-1 ${
                      filterProject === p.id
                        ? 'bg-brand-accent text-brand-foreground border-brand-accent'
                        : 'hover:bg-muted border-transparent'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
                {documents.some(d => !d.project) && (
                  <button
                    onClick={() => setFilterProject('none')}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                      filterProject === 'none'
                        ? 'bg-brand-accent text-brand-foreground border-brand-accent'
                        : 'hover:bg-muted border-transparent'
                    }`}
                  >
                    No folder
                  </button>
                )}
              </div>
            )}

            {/* File list */}
            {docsError ? (
              <LoadErrorState message="Couldn't load your files." onRetry={loadDocs} retrying={docsRetrying} className="py-6" />
            ) : filteredDocs.length === 0 ? (
              <Empty className="border-2 rounded-xl">
                <EmptyHeader>
                  <EmptyMedia>
                    <FileText className="size-12 text-muted-foreground/40" />
                  </EmptyMedia>
                  <EmptyTitle>No files yet</EmptyTitle>
                  <EmptyDescription>
                    Files you upload in chats or add to a project's Knowledge tab will appear here.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" onClick={() => router.push('/')}>
                    Go to Digby
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <div className="space-y-2">
                {filteredDocs.map(doc => (
                  <div key={doc.id} className="flex items-center gap-3 rounded-xl border p-3 group hover:bg-muted/20 transition-colors">
                    {doc.mimeType === 'url'
                      ? <Globe className="size-4 text-ink-2 flex-shrink-0" />
                      : <FileText className="size-4 text-brand-accent flex-shrink-0" />
                    }
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium truncate">{doc.name}</p>
                        <SourceBadge source={doc.source} />
                        {doc.project && (
                          <button
                            onClick={() => router.push(`/projects/${doc.project!.id}`)}
                            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 border border-transparent hover:border-muted-foreground/20 rounded-full px-1.5 py-0.5"
                          >
                            {doc.project.name}
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        <DocStatusBadge status={doc.status} />
                        {doc.status === 'ready' && (
                          <span className="text-[10px] text-muted-foreground">
                            {doc.chunkCount} chunks · {(doc.charCount / 1000).toFixed(1)}k chars
                          </span>
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          {absoluteDate(doc.createdAt)}
                        </span>
                      </div>
                    </div>
                    {doc.project && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 opacity-60 md:opacity-0 md:group-hover:opacity-100 flex-shrink-0"
                        onClick={() => router.push(`/projects/${doc.project!.id}?tab=knowledge`)}
                        title="View in folder"
                      >
                        <FolderOpen className="size-3.5" />
                      </Button>
                    )}
                    <button
                      onClick={() => setDeletingDocId(doc.id)}
                      className="p-1.5 rounded-md opacity-60 md:opacity-0 md:group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-destructive transition-all flex-shrink-0"
                      title="Delete file"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* ── Chat uploads (persisted per-chat files — images included) ── */}
            <div className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-sm font-semibold">Chat uploads</h2>
                {chatUploads.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">({chatUploads.length})</span>
                )}
              </div>
              {uploadsError ? (
                <LoadErrorState message="Couldn't load chat uploads." onRetry={loadUploads} retrying={uploadsRetrying} className="py-6" />
              ) : chatUploads.length === 0 ? (
                <p className="text-xs text-muted-foreground border border-dashed rounded-lg px-3 py-4 text-center">
                  No chat uploads yet — attach a file to a message and it will appear here.
                </p>
              ) : (
                <div className="space-y-2">
                  {chatUploads.map(file => (
                    <div key={file.id} className="flex items-center gap-3 rounded-xl border p-3 group hover:bg-muted/20 transition-colors">
                      {previewKindForMime(file.mimeType) === 'image' ? (
                        <AuthedFileImage
                          target={{ kind: 'chat-file', id: file.id, route: 'inline' }}
                          alt={file.filename}
                          className="size-10 flex-shrink-0 rounded-md object-cover border"
                        />
                      ) : (
                        <UploadFileTypeIcon mimeType={file.mimeType} />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate" title={file.filename}>{file.filename}</p>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-[10px] text-muted-foreground">{formatSize(file.sizeBytes)}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {absoluteDate(file.createdAt)}
                          </span>
                          <button
                            onClick={() => router.push(`/?chatId=${file.chatId}`)}
                            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                            title="Open source chat"
                          >
                            <MessageSquare className="size-2.5" />
                            Source chat
                          </button>
                        </div>
                      </div>
                      <Button
                        variant="ghost" size="icon"
                        className="size-7 opacity-60 md:opacity-0 md:group-hover:opacity-100 flex-shrink-0"
                        onClick={() => setPreviewUpload(file)}
                        title="Preview"
                      >
                        <Eye className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost" size="icon"
                        className="size-7 opacity-60 md:opacity-0 md:group-hover:opacity-100 flex-shrink-0"
                        onClick={() => handleDownloadUpload(file)}
                        title="Download file"
                      >
                        <Download className="size-3.5" />
                      </Button>
                      <button
                        onClick={() => setDeletingUploadId(file.id)}
                        className="p-1.5 rounded-md opacity-60 md:opacity-0 md:group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-destructive transition-all flex-shrink-0"
                        title="Delete file"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ── Generated files (created by Digby) ── */}
            <div className="pt-4">
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-sm font-semibold">Generated by Digby</h2>
                {generatedFiles.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">({generatedFiles.length})</span>
                )}
              </div>
              {generatedError ? (
                <LoadErrorState message="Couldn't load generated files." onRetry={loadGenerated} retrying={generatedRetrying} className="py-6" />
              ) : generatedFiles.length === 0 ? (
                <p className="text-xs text-muted-foreground border border-dashed rounded-lg px-3 py-4 text-center">
                  No generated files yet — ask Digby to create a document, spreadsheet or image.
                </p>
              ) : (
                <div className="space-y-2">
                  {generatedFiles.map(file => (
                    <div key={file.id} className="flex items-center gap-3 rounded-xl border p-3 group hover:bg-muted/20 transition-colors">
                      {/* Generated IMAGES (generate_image, 2026-09-24): the same
                          size-10 authed thumbnail the chat-upload rows render,
                          fetched from the generated file's inline route. */}
                      {previewKindForMime(file.mimeType) === 'image' ? (
                        <AuthedFileImage
                          target={{ kind: 'generated', id: file.id, route: 'inline' }}
                          alt={file.filename}
                          className="size-10 flex-shrink-0 rounded-md object-cover border"
                        />
                      ) : (
                        <GeneratedFileIcon format={file.format} />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium truncate">{file.filename}</p>
                          <Badge variant="outline" className="text-[10px] uppercase py-0 h-4 px-1.5">
                            {file.format}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                          <span className="text-[10px] text-muted-foreground">{formatSize(file.size)}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {absoluteDate(file.createdAt)}
                          </span>
                        </div>
                      </div>
                      {previewKindForMime(file.mimeType) === 'image' && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 opacity-60 md:opacity-0 md:group-hover:opacity-100 flex-shrink-0"
                          onClick={() => setPreviewGenerated(file)}
                          title="Preview"
                        >
                          <Eye className="size-3.5" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 opacity-60 md:opacity-0 md:group-hover:opacity-100 flex-shrink-0"
                        onClick={() => handleDownloadGenerated(file)}
                        title="Download file"
                      >
                        <Download className="size-3.5" />
                      </Button>
                      <button
                        onClick={() => setDeletingGeneratedId(file.id)}
                        className="p-1.5 rounded-md opacity-60 md:opacity-0 md:group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-destructive transition-all flex-shrink-0"
                        title="Delete file"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* ═══ CANVASES TAB ═══ */}
        {activeTab === 'canvases' && (
          <>
            {cvsError ? (
              <LoadErrorState message="Couldn't load the files created in your chats." onRetry={loadCanvases} retrying={cvsRetrying} className="py-6" />
            ) : canvases.length === 0 ? (
              <Empty className="border-2 rounded-xl">
                <EmptyHeader>
                  <EmptyMedia>
                    <LayoutTemplate className="size-12 text-muted-foreground/40" />
                  </EmptyMedia>
                  <EmptyTitle>No files created yet</EmptyTitle>
                  <EmptyDescription>
                    Ask Digby to create a document, code file, or diagram and it will appear here.
                  </EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button variant="outline" onClick={() => router.push('/')}>
                    Go to Digby
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              <div className="space-y-2">
                {canvases.map(canvas => (
                  <div key={canvas.id} className="flex items-center gap-3 rounded-xl border p-3 group hover:bg-muted/20 transition-colors">
                    {/* Type icon */}
                    {(() => {
                      const Icon = TYPE_ICONS[canvas.type as keyof typeof TYPE_ICONS] || FileText;
                      const color = TYPE_COLORS[canvas.type as keyof typeof TYPE_COLORS] || TYPE_COLORS.document;
                      return <Icon className={`size-4 flex-shrink-0 ${color.split(' ')[0]}`} />;
                    })()}

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium truncate">{canvas.title}</p>
                        <CanvasTypeBadge type={canvas.type} language={canvas.language} />
                        {canvas.version > 1 && (
                          <span className="text-[10px] text-muted-foreground font-mono">v{canvas.version}</span>
                        )}
                        {/* Project badge (if chat is in a project) */}
                        {canvas.chat.project && (
                          <button
                            onClick={() => router.push(`/projects/${canvas.chat.project!.id}`)}
                            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 border border-transparent hover:border-muted-foreground/20 rounded-full px-1.5 py-0.5"
                          >
                            {canvas.chat.project.name}
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                        {/* Chat link — opens the chat this canvas was created in */}
                        <button
                          onClick={() => router.push(`/?chatId=${canvas.chat.id}`)}
                          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                          title="Open source chat"
                        >
                          <MessageSquare className="size-2.5" />
                          <span className="max-w-[160px] truncate">{canvas.chat.title}</span>
                        </button>
                        <span className="text-[10px] text-muted-foreground">
                          {absoluteDate(canvas.createdAt)}
                        </span>
                      </div>
                    </div>

                    {/* Open in chat button */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 opacity-60 md:opacity-0 md:group-hover:opacity-100 flex-shrink-0"
                      onClick={() => router.push(`/?chatId=${canvas.chat.id}`)}
                      title="Open in chat"
                    >
                      <ExternalLink className="size-3.5" />
                    </Button>

                    {/* Delete button */}
                    <button
                      onClick={() => setDeletingCanvasId(canvas.id)}
                      className="p-1.5 rounded-md opacity-60 md:opacity-0 md:group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-destructive transition-all flex-shrink-0"
                      title="Delete file"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* ── Delete doc confirmation ── */}
      <AlertDialog open={!!deletingDocId} onOpenChange={open => !open && setDeletingDocId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the document and all its chunks from the knowledge base.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingDocId && handleDeleteDoc(deletingDocId)}
              className="bg-destructive hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete canvas confirmation ── */}
      <AlertDialog open={!!deletingCanvasId} onOpenChange={open => !open && setDeletingCanvasId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the file. The chat that created it will remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingCanvasId && handleDeleteCanvas(deletingCanvasId)}
              className="bg-destructive hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete generated file confirmation ── */}
      <AlertDialog open={!!deletingGeneratedId} onOpenChange={open => !open && setDeletingGeneratedId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this generated file?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the file. The chat that created it will remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingGeneratedId && handleDeleteGenerated(deletingGeneratedId)}
              className="bg-destructive hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete chat upload confirmation ── */}
      <AlertDialog open={!!deletingUploadId} onOpenChange={open => !open && setDeletingUploadId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this upload?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the uploaded file. The chat it was sent in will remain.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingUploadId && handleDeleteUpload(deletingUploadId)}
              className="bg-destructive hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* In-panel preview for chat uploads (images/pdf/text/docx/xlsx). */}
      {previewUpload && <FilePreviewModal file={previewUpload} onClose={() => setPreviewUpload(null)} />}
      {/* Generated image preview (2026-09-24) — shared lightbox on the inline route. */}
      {previewGenerated && (
        <AuthedImageLightbox
          target={{ kind: 'generated', id: previewGenerated.id, route: 'inline' }}
          alt={previewGenerated.filename}
          onClose={() => setPreviewGenerated(null)}
        />
      )}
    </div>
  );
}
