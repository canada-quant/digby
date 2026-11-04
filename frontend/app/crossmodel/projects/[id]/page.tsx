'use client';

import { useState, useEffect, useCallback } from 'react';
import { absoluteDate } from '@/lib/relative-time';
import { useParams, useRouter } from 'next/navigation';
import NextLink from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import {
  MessageSquare,
  Plus,
  FileText,
  Loader2,
  Trash2,
  Globe,
  UserPlus,
  X,
  Save,
  Upload,
  Link,
  Code2,
  GitBranch,
  FolderGit2,
  RefreshCw,
  Archive,
  ArchiveRestore,
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { authApi } from '@/lib/auth';
import { isDefinitiveAuthFailure } from '@/lib/api-client';
import { projectsApi, filesApi, type ProjectDetail, type ProjectSessionRow } from '@/lib/api/crossmodel';
import { receiptAgeLabel } from '@/lib/session-title';
import { codingApi } from '@/lib/api/coding';
import { fleetApi, type FleetDigest } from '@/lib/api/fleet';
import { cn } from '@/lib/utils';
import { usePolling } from '@/lib/use-polling';
import { DocStatusBadge } from '../../components/badges';
import { ProjectPulse } from '../../components/ProjectPulse';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { PageBackButton } from '@/components/ui/page-back-button';
import { ScrollableTabBar } from '@/components/ui/scrollable-tab-bar';
import { useMinimalView } from '@/lib/view-mode';

type Tab = 'chats' | 'sessions' | 'files' | 'workspace' | 'members' | 'settings';

function MimeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType === 'url') return <Globe className="size-4 text-ink-2" />;
  return <FileText className="size-4 text-brand-accent" />;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ProjectPage() {
  // Minimal view (2026-10-16): no receipt ages, spend or charter jargon for a user.
  const minimal = useMinimalView();
  const params = useParams();
  const router = useRouter();
  const projectId = params.id as string;

  const [user, setUser] = useState<any>(null);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>('chats');
  // One-Digby workspace tab state
  const [ws, setWs] = useState<{ provider: string | null; repoUrl: string | null; defaultBranch: string; provisioned: boolean; knowledgeBranch: string | null } | null | undefined>(undefined);
  const [wsLoadError, setWsLoadError] = useState(false);
  const [wsBusy, setWsBusy] = useState(false);
  const [wsRepoUrl, setWsRepoUrl] = useState('');
  const [startingChat, setStartingChat] = useState(false);
  // Project Pulse (owner 2026-09-04): this project's hourly digest, picked
  // client-side out of GET /fleet/digests. undefined = loading or a failed
  // fetch (render NOTHING — incl. child accounts, which the fleet routes 403);
  // null = fetched but no digest row yet (honest "no pulse yet" state).
  const [pulse, setPulse] = useState<FleetDigest | null | undefined>(undefined);
  // Sessions view (session titles + topology, 2026-09-27): loaded on the tab's
  // first open; archived rows only on request.
  const [sessions, setSessions] = useState<ProjectSessionRow[] | null>(null);
  const [sessionsPartial, setSessionsPartial] = useState(false);
  const [sessionsArchived, setSessionsArchived] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // One-Digby: "New Chat" in a workspace project creates a workspace-backed
  // chat (satellite at birth) and opens it inline; plain projects keep the
  // project-scoped composer on the home page.
  const startNewChat = async () => {
    if (project?.repoProvider) {
      if (startingChat) return;
      setStartingChat(true);
      try {
        const sess = await codingApi.createSession(projectId, { title: 'New chat' });
        router.push(`/?chatId=${sess.id}`);
      } catch (e: any) {
        toast.error(e?.response?.data?.error || 'Could not start the chat');
      } finally {
        setStartingChat(false);
      }
      return;
    }
    router.push(`/?projectId=${projectId}`);
  };

  // ── Files state ───────────────────────────────────────────────────────────
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const [showUrlDialog, setShowUrlDialog] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [urlName, setUrlName] = useState('');
  const [addingUrl, setAddingUrl] = useState(false);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);

  // ── Members state ─────────────────────────────────────────────────────────
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'viewer' | 'editor'>('viewer');
  const [inviting, setInviting] = useState(false);

  // ── Settings state ────────────────────────────────────────────────────────
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editSystemPrompt, setEditSystemPrompt] = useState('');
  const [editEmoji, setEditEmoji] = useState('📁');
  const [editCrossProjectMemory, setEditCrossProjectMemory] = useState(true); // default-on (owner 2026-09-08); load overwrites
  const [editSupervised, setEditSupervised] = useState(true); // default-on (ticket 3217e287); load overwrites
  // Project supervisor (2026-09-14): immediate toggle, NOT part of the Save
  // form — it scaffolds/pauses a live agent, so it applies on flip. Defaults
  // false — checked only on explicit true.
  const [supervisorEnabled, setSupervisorEnabled] = useState(false);
  const [supervisorChatId, setSupervisorChatId] = useState<string | null>(null);
  // Auto-archive idle chats (ticket bb86cee8): immediate select, NOT part of
  // the Save form — like the project supervisor it applies on change. null =
  // off; otherwise the hourly backend job archives chats idle longer than
  // this. Defaults null — read back from the fetched project.
  const [autoArchiveDays, setAutoArchiveDays] = useState<number | null>(null);
  // Budget & merge policy (T4c, 2026-09-24): tool-settable before, now visible + editable here.
  const [spendCapInput, setSpendCapInput] = useState<string>('');
  const [spendCapSaved, setSpendCapSaved] = useState<number | null>(null);
  const [selfMerge, setSelfMerge] = useState<'on' | 'off' | 'default'>('default');
  const [autoIngestGmail, setAutoIngestGmail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showDeleteProject, setShowDeleteProject] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [archivingProject, setArchivingProject] = useState(false);

  // ── Auth guard ────────────────────────────────────────────────────────────
  useEffect(() => {
    authApi.getCurrentUser()
      .then(setUser)
      .catch((err) => {
        // 05303f58: bounce only on a definitive 401 (refresh already failed) —
        // a network blip/5xx keeps the token and the loading state stays.
        if (isDefinitiveAuthFailure(err)) router.push('/login');
        else console.warn('getCurrentUser failed (non-auth) — staying put', err);
      });
  }, []);

  // ── Load project ──────────────────────────────────────────────────────────
  const loadProject = useCallback(async () => {
    try {
      const data = await projectsApi.get(projectId);
      setProject(data);
      setEditName(data.name);
      setEditDescription(data.description ?? '');
      setEditSystemPrompt(data.systemPrompt ?? '');
      setEditEmoji(data.emoji ?? '📁');
      // Default-on (owner 2026-09-08): unset reads as enabled; only an explicit false isolates.
      setEditCrossProjectMemory(data.crossProjectMemory !== false);
      // Default-on (ticket 3217e287): unset reads as supervised; only an explicit false opts out.
      setEditSupervised(data.supervised !== false);
      // Defaults false: checked only when the backend explicitly says true.
      setSupervisorEnabled(data.projectSupervisorEnabled === true);
      setSupervisorChatId(data.projectSupervisorChatId ?? null);
      // Gmail auto-ingest (99145890): default-off, explicit true only.
      setAutoIngestGmail(data.autoIngestGmailAttachments === true);
      // null/absent = off; any stored integer selects that window.
      setAutoArchiveDays(data.autoArchiveIdleDays ?? null);
      setSpendCapSaved(data.spendCapUsdPerDay ?? null);
      setSpendCapInput(data.spendCapUsdPerDay != null ? String(data.spendCapUsdPerDay) : '');
      setSelfMerge(data.selfMerge === 'on' || data.selfMerge === 'off' ? data.selfMerge : 'default');
    } catch (err: any) {
      toast.error('Failed to load folder');
      router.push('/');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (user) loadProject();
  }, [user, loadProject]);

  // Project Pulse fetch — once per signed-in visit (the digest itself only
  // changes hourly; the management dashboard is the live-polling surface).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fleetApi.getDigests()
      .then((r) => { if (!cancelled) setPulse(r.digests.find((d) => d.projectId === projectId) ?? null); })
      .catch(() => { /* keep undefined — never render a wrong or empty-looking pulse over an outage */ });
    return () => { cancelled = true; };
  }, [user, projectId]);

  // Poll for processing documents — usePolling (P5): abortable ticks so a
  // slow response can never overwrite a fresher project detail; `enabled`
  // stops the poll the moment no document is processing (setProject flips it).
  const hasProcessingDocs = !!project?.documents.some(d => d.status === 'processing');
  usePolling(
    (signal) => projectsApi.get(projectId, { signal }),
    {
      intervalMs: 3000,
      enabled: hasProcessingDocs,
      pauseWhenHidden: false, // legacy behavior: ingestion progress keeps updating in a background tab
      onData: setProject,
    },
  );

  // ── Handlers ──────────────────────────────────────────────────────────────

  // ── Upload multiple files (from input or drag & drop) ────────────────────
  const uploadFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    setUploadingDoc(true);
    let successCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadProgress(files.length > 1 ? `Uploading ${i + 1}/${files.length}: ${file.name}` : file.name);
      try {
        // Read into safe buffer before any async gaps (avoids Chrome File permission revocation)
        const buffer = await file.arrayBuffer();
        const safeFile = new File([buffer], file.name, { type: file.type });
        await filesApi.uploadToProject(projectId, safeFile);
        successCount++;
      } catch (err: any) {
        toast.error(`Failed: "${file.name}" — ${err?.response?.data?.error || 'upload error'}`);
      }
    }

    setUploadProgress('');
    setUploadingDoc(false);

    if (successCount > 0) {
      await loadProject();
      toast.success(
        files.length === 1
          ? `"${files[0].name}" is being processed…`
          : `${successCount} of ${files.length} files are being processed…`
      );
    }
  }, [projectId, loadProject]);

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    const input = e.target;
    if (!files || files.length === 0) return;
    // Snapshot files before clearing input (Chrome revokes access after clear)
    const snapshots = await Promise.all(
      Array.from(files).map(async (f) => {
        const buf = await f.arrayBuffer();
        return new File([buf], f.name, { type: f.type });
      })
    );
    input.value = ''; // safe to clear now
    await uploadFiles(snapshots);
  }, [uploadFiles]);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    await uploadFiles(files);
  }, [uploadFiles]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleAddUrl = useCallback(async () => {
    if (!urlInput.trim()) return;
    setAddingUrl(true);
    try {
      await filesApi.addUrlToProject(projectId, urlInput.trim(), urlName.trim() || undefined);
      await loadProject();
      setShowUrlDialog(false);
      setUrlInput('');
      setUrlName('');
      toast.success('URL is being analyzed by Digby…');
    } catch {
      toast.error('Failed to add URL');
    } finally {
      setAddingUrl(false);
    }
  }, [projectId, urlInput, urlName, loadProject]);

  const handleDeleteDoc = useCallback(async (docId: string) => {
    setDeletingDocId(null);
    try {
      await filesApi.deleteDocument(docId);
      setProject(prev => prev ? { ...prev, documents: prev.documents.filter(d => d.id !== docId) } : prev);
      toast.success('Document deleted');
    } catch {
      toast.error('Failed to delete document');
    }
  }, []);

  const handleInviteMember = useCallback(async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      // Normalize email to lowercase — backend also does this, but normalize early
      // to avoid case-sensitivity issues with PostgreSQL unique constraints
      const newMember = await projectsApi.addMember(projectId, { email: inviteEmail.trim().toLowerCase(), role: inviteRole });
      setProject(prev => prev ? { ...prev, members: [...prev.members, newMember] } : prev);
      setInviteEmail('');
      toast.success(`Invited ${inviteEmail}`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to invite member');
    } finally {
      setInviting(false);
    }
  }, [projectId, inviteEmail, inviteRole]);

  const handleRemoveMember = useCallback(async (memberId: string) => {
    try {
      await projectsApi.removeMember(projectId, memberId);
      setProject(prev => prev ? { ...prev, members: prev.members.filter(m => m.userId !== memberId) } : prev);
      toast.success('Member removed');
    } catch {
      toast.error('Failed to remove member');
    }
  }, [projectId]);

  const handleSaveSettings = useCallback(async () => {
    setSaving(true);
    try {
      await projectsApi.update(projectId, {
        name: editName.trim() || project!.name,
        description: editDescription.trim() || undefined,
        systemPrompt: editSystemPrompt.trim() || undefined,
        emoji: editEmoji,
        crossProjectMemory: editCrossProjectMemory,
        supervised: editSupervised,
        autoIngestGmailAttachments: autoIngestGmail,
      });
      await loadProject();
      toast.success('Folder updated');
    } catch {
      toast.error('Failed to update folder');
    } finally {
      setSaving(false);
    }
  }, [projectId, editName, editDescription, editSystemPrompt, editEmoji, editCrossProjectMemory, editSupervised, autoIngestGmail, project, loadProject]);

  /**
   * Project supervisor toggle (2026-09-14) — immediate (applies on flip, not via
   * Save Changes): ON scaffolds a dedicated supervisor agent for this folder
   * (within a minute, fire-and-forget ensure); OFF pauses it (hooks+schedules
   * disabled, history never deleted). Optimistic; revert + toast on failure.
   */
  const toggleProjectSupervisor = useCallback(async (enabled: boolean) => {
    setSupervisorEnabled(enabled);
    try {
      await projectsApi.update(projectId, { projectSupervisorEnabled: enabled });
      toast.success(enabled
        ? 'Project supervisor enabled — it will scaffold within a minute.'
        : 'Project supervisor paused (history preserved).');
    } catch {
      setSupervisorEnabled(!enabled);
      toast.error('Could not update the project supervisor.');
    }
  }, [projectId]);

  /**
   * Auto-archive idle chats (ticket bb86cee8) — immediate select (applies on
   * change, not via Save Changes), same pattern as the supervisor toggle: the
   * hourly idle-chat archiver archives this folder's chats whose last
   * activity is older than the picked window; Off (null) disables it.
   * Optimistic; revert + toast on failure.
   */
  const updateAutoArchiveDays = useCallback(async (days: number | null) => {
    const previous = autoArchiveDays;
    setAutoArchiveDays(days);
    try {
      await projectsApi.update(projectId, { autoArchiveIdleDays: days });
      toast.success(days === null
        ? 'Auto-archive off — idle chats stay put.'
        : `Auto-archive on — chats idle over ${days} days move to Archived (checked hourly).`);
    } catch {
      setAutoArchiveDays(previous);
      toast.error('Could not update auto-archive.');
    }
  }, [projectId, autoArchiveDays]);

  /** Budget & merge policy (T4c): the spend cap saves on blur/Enter, the merge policy on change. */
  const saveSpendCap = useCallback(async () => {
    const raw = spendCapInput.trim();
    const next = raw === '' ? null : Number(raw);
    if (next !== null && (!Number.isFinite(next) || next <= 0 || next > 1_000_000)) {
      toast.error('Spend cap must be a positive number of USD per day (or empty for no cap).');
      setSpendCapInput(spendCapSaved != null ? String(spendCapSaved) : '');
      return;
    }
    if (next === spendCapSaved) return;
    try {
      await projectsApi.update(projectId, { spendCapUsdPerDay: next });
      setSpendCapSaved(next);
      toast.success(next === null ? 'Spend cap removed.' : `Spend cap set to $${next}/day.`);
    } catch {
      setSpendCapInput(spendCapSaved != null ? String(spendCapSaved) : '');
      toast.error('Could not update the spend cap.');
    }
  }, [projectId, spendCapInput, spendCapSaved]);
  const updateSelfMerge = useCallback(async (value: 'on' | 'off' | 'default') => {
    const previous = selfMerge;
    setSelfMerge(value);
    try {
      await projectsApi.update(projectId, { selfMerge: value === 'default' ? null : value });
      toast.success(value === 'default' ? 'Self-merge follows the platform default.' : value === 'on' ? 'Machine runs may merge their own PRs when the gates pass.' : 'Machine runs never merge — a human merges.');
    } catch {
      setSelfMerge(previous);
      toast.error('Could not update the merge policy.');
    }
  }, [projectId, selfMerge]);

  const handleDeleteProject = useCallback(async () => {
    setDeletingProject(true);
    try {
      await projectsApi.delete(projectId);
      router.push('/');
      toast.success('Folder deleted');
    } catch {
      toast.error('Failed to delete folder');
      setDeletingProject(false);
    }
  }, [projectId, router]);

  // Archive — the reversible de-clutter path above the Danger Zone: the folder
  // (and its chats/subfolders, implicitly) leaves the sidebar; restore from the
  // sidebar's Archived section brings everything back. No confirmation dialog —
  // archive is lossless; 409s (running sessions / enabled schedules) surface
  // with the backend's honest reason.
  const handleArchiveProject = useCallback(async () => {
    setArchivingProject(true);
    try {
      await projectsApi.archive(projectId);
      router.push('/');
      toast.success('Folder archived — restore it from the sidebar’s Archived section');
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to archive folder');
      setArchivingProject(false);
    }
  }, [projectId, router]);

  // Restore — shown in place of Archive when the folder was opened by direct
  // link while archived (direct loads keep working; archive is not tombstoning).
  const handleRestoreProject = useCallback(async () => {
    setArchivingProject(true);
    try {
      await projectsApi.restore(projectId);
      toast.success('Folder restored');
      await loadProject();
    } catch {
      toast.error('Failed to restore folder');
    } finally {
      setArchivingProject(false);
    }
  }, [projectId, loadProject]);

  useEffect(() => {
    if (activeTab !== 'workspace' || ws !== undefined) return;
    // A failed fetch must NOT render as "No workspace yet" — track it separately.
    projectsApi.getWorkspace(projectId)
      .then((w) => { setWs(w); setWsLoadError(false); })
      .catch(() => { setWs(null); setWsLoadError(true); });
  }, [activeTab, ws, projectId]);

  // Sessions view (2026-09-27): fetch on first open + whenever the archived toggle flips.
  const loadSessions = useCallback((archived: boolean) => {
    setSessionsLoading(true);
    projectsApi.sessions(projectId, { archived })
      .then((r) => { setSessions(r.sessions); setSessionsPartial(r.partial); })
      .catch(() => { setSessions((prev) => prev ?? []); setSessionsPartial(true); })
      .finally(() => setSessionsLoading(false));
  }, [projectId]);
  useEffect(() => {
    if (activeTab !== 'sessions' || sessions !== null) return;
    loadSessions(sessionsArchived);
  }, [activeTab, sessions, sessionsArchived, loadSessions]);

  // Owner 2026-10-27 (stale-list sweep, finding C): this page loads ONCE and
  // its only poll is doc-processing-gated — a project renamed/archived/
  // deleted in another tab (or by the hourly auto-archiver) kept rendering the
  // old state until a manual reload. Reconcile on focus (BOTH focus and
  // visibilitychange — the app's convention, CodeSessionView resyncActive):
  // pull the detail so the header/tabs/counts repaint, and, when the Sessions
  // tab is open, its lane roster. The EDITOR fields (editName/…, seeded only
  // by loadProject) are deliberately NOT re-seeded here (review round 1,
  // finding 5): a focus mid-edit must never clobber unsaved text — only the
  // read-only surfaces (header/counts/roster) reconcile. A generation counter
  // guards every async answer (finding 6): a stale roster/detail response can
  // never overwrite a newer one (same discipline as usePolling's abortable
  // ticks). Fail-open; a 404 (project gone) routes home quietly — loadProject's
  // own catch already toasts for the initial load.
  useEffect(() => {
    let gen = 0;
    const onFocus = () => {
      const myGen = ++gen;
      void projectsApi.get(projectId)
        .then((data) => { if (myGen === gen) setProject(data); })
        .catch((err: any) => {
          if (err?.response?.status === 404) router.push('/');
        });
      // Sessions tab open → refresh the roster in place (it never refetches
      // once non-null; a lane deleted/archived elsewhere kept its row).
      if (activeTab === 'sessions') {
        setSessionsLoading(true);
        projectsApi.sessions(projectId, { archived: sessionsArchived })
          .then((r) => { if (myGen === gen) { setSessions(r.sessions); setSessionsPartial(r.partial); } })
          .catch(() => { /* keep the current roster — focus reconcile is fail-open */ })
          .finally(() => { if (myGen === gen) setSessionsLoading(false); });
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [projectId, activeTab, sessionsArchived, router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!project) return null;

  const isOwner = project.role === 'owner';
  const canEdit = project.role === 'owner' || project.role === 'admin' || project.role === 'editor';

  const projectTabs = [
    { id: 'chats' as const, label: `Chats (${project.chats.length})` },
    { id: 'sessions' as const, label: sessions ? `Sessions (${sessions.length})` : 'Sessions' },
    { id: 'files' as const, label: `Files (${project.documents.length})` },
    { id: 'workspace' as const, label: 'Workspace' },
    { id: 'members' as const, label: `Members (${project.members.length})` },
    ...(isOwner ? [{ id: 'settings' as const, label: 'Settings' }] : []),
  ];

  return (
    // h-dvh + internal scroll: globals.css disables body scroll app-wide, so a
    // min-h-screen root has no scroll container and everything below the fold
    // is unreachable (same bug class as app/login/page.tsx). The root IS the
    // scroll container so the sticky header sticks inside it; dialogs portal out.
    <div className="h-dvh overflow-y-auto bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 sticky top-0 z-10" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <PageBackButton onClick={() => router.push('/')} label="Back to chats" />
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="min-w-0">
              <h1 className="font-bold text-base truncate">{project.name}</h1>
              {project.description && (
                <p className="text-xs text-muted-foreground truncate">{project.description}</p>
              )}
            </div>
          </div>
          <Button
            size="sm"
            className="bg-send text-send-ink hover:opacity-90 border-0 gap-2 min-h-10"
            disabled={startingChat}
            onClick={startNewChat}
          >
            <Plus className="size-3.5" />
            <span className="hidden sm:inline">New Chat</span>
          </Button>
        </div>
        <div className="max-w-4xl mx-auto px-4 border-t">
          <ScrollableTabBar
            ariaLabel="Project sections"
            value={activeTab}
            onChange={setActiveTab}
            tabs={projectTabs}
          />
        </div>
      </header>

      <main id="main" tabIndex={-1} className="max-w-4xl mx-auto px-4 py-6 outline-none">

        {/* ── PROJECT PULSE (owner 2026-09-04) — the hourly plain-English
            summary + goal-progress/ETA chips for THIS project, same shared
            block the management dashboard and the session Fleet tab render.
            Hidden entirely while loading / after a failed fetch. ── */}
        {pulse !== undefined && (
          <div className="mb-5 rounded-xl border bg-card/50 p-4">
            <ProjectPulse digest={pulse} title="Project pulse" />
          </div>
        )}

        {/* ── SESSIONS TAB (session titles + topology, 2026-09-27) ── */}
        {activeTab === 'sessions' && (
          <div className="space-y-3" data-sessions-view>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                Every lane in this project: goal · current step, live status, last receipt, today&apos;s spend.{sessionsPartial ? ' Some columns did not load.' : ''}
              </p>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Switch checked={sessionsArchived} onCheckedChange={(v) => { setSessionsArchived(v); loadSessions(v); }} aria-label="Show archived sessions" />
                  archived
                </label>
                <Button variant="ghost" size="sm" onClick={() => loadSessions(sessionsArchived)} disabled={sessionsLoading} aria-label="Refresh sessions">
                  <RefreshCw className={`size-4 ${sessionsLoading ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </div>
            {sessions === null || (sessionsLoading && sessions.length === 0) ? (
              <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
            ) : sessions.length === 0 ? (
              <Empty className="py-16 border-none">
                <EmptyHeader>
                  <EmptyMedia><Code2 className="size-12 text-muted-foreground/40" /></EmptyMedia>
                  <EmptyTitle>No sessions yet</EmptyTitle>
                  <EmptyDescription>Lanes spawned into this project appear here with their goal and current step.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              sessions.map((s) => (
                <div
                  key={s.chatId}
                  className="flex items-center gap-3 rounded-xl border p-3 hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() => router.push(`/?chatId=${s.chatId}`)}
                  data-session-row={s.status}
                >
                  <Badge
                    variant={s.status === 'running' ? 'default' : 'outline'}
                    className={`text-[10px] capitalize flex-shrink-0 ${s.status === 'running' ? '' : s.status === 'scheduled' ? 'text-brand-accent' : 'text-muted-foreground'}`}
                  >
                    {s.status}
                  </Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">
                      <span className="font-medium">{s.goalHalf}</span>
                      {s.stepHalf && <span className="text-muted-foreground"> · {s.stepHalf}</span>}
                      {s.pinned && <span className="ml-1 text-[10px] text-muted-foreground" title="Title pinned by a rename">pinned</span>}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {s.isSupervisor ? 'supervisor' : s.goalTitle ? `goal: ${s.goalTitle}` : minimal ? '' : 'no charter'}
                      {s.todoCounts.open > 0 ? ` · ${s.todoCounts.open} open todo${s.todoCounts.open === 1 ? '' : 's'}` : ''}
                      {!minimal && ` · last receipt ${receiptAgeLabel(s.lastReceiptAgeSec)}`}
                      {!minimal && s.spendTodayUsd != null ? ` · $${s.spendTodayUsd.toFixed(2)} today` : ''}
                      {s.enabledSchedules > 0 ? ` · ${s.enabledSchedules} schedule${s.enabledSchedules === 1 ? '' : 's'}` : ''}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── CHATS TAB ── */}
        {activeTab === 'chats' && (
          <div className="space-y-3">
            {project.chats.length === 0 ? (
              <Empty className="py-16 border-none">
                <EmptyHeader>
                  <EmptyMedia>
                    <MessageSquare className="size-12 text-muted-foreground/40" />
                  </EmptyMedia>
                  <EmptyTitle>No chats yet</EmptyTitle>
                  <EmptyDescription>Start a conversation in this folder</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    className="bg-send text-send-ink hover:opacity-90 border-0"
                    disabled={startingChat}
                    onClick={startNewChat}
                  >
                    <Plus className="size-4 mr-2" />
                    New Chat
                  </Button>
                </EmptyContent>
              </Empty>
            ) : (
              project.chats.map(chat => (
                <div
                  key={chat.id}
                  className="flex items-center gap-3 rounded-xl border p-3 hover:bg-muted/30 cursor-pointer transition-colors group"
                  onClick={() => router.push(`/?chatId=${chat.id}`)}
                >
                  {/* User Space (P3): the SATELLITE (hasWorkspaceState) marks a
                      workspace chat — codeCapable only means "attachable" and
                      every auto-filed chat carries it, so it can't key the icon. */}
                  {chat.hasWorkspaceState
                    ? <Code2 className="size-4 text-brand-accent flex-shrink-0" />
                    : <MessageSquare className="size-4 text-muted-foreground flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{chat.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {absoluteDate(chat.updatedAt)}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-xs capitalize flex-shrink-0">{chat.mode}</Badge>
                </div>
              ))
            )}
          </div>
        )}

        {/* ── FILES TAB ── */}
        {activeTab === 'files' && (
          <div className="space-y-4">
            {/* System prompt preview */}
            {project.systemPrompt && (
              <div className="rounded-xl border bg-brand-faint p-4">
                <p className="text-[12px] font-medium text-brand-text mb-1.5">Custom Instructions</p>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">{project.systemPrompt}</p>
              </div>
            )}

            {/* Upload toolbar */}
            {canEdit && (
              <div className="flex gap-2 flex-wrap items-center">
                <Label className="cursor-pointer">
                  <div className={cn(
                    'flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors text-sm font-medium',
                    uploadingDoc ? 'opacity-60 cursor-not-allowed' : 'hover:bg-muted/60 cursor-pointer'
                  )}>
                    {uploadingDoc
                      ? <Loader2 className="size-4 animate-spin" />
                      : <Upload className="size-4" />
                    }
                    {uploadingDoc && uploadProgress
                      ? <span className="max-w-[200px] truncate text-xs text-muted-foreground">{uploadProgress}</span>
                      : 'Upload Files'
                    }
                  </div>
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png,.webp,.gif,image/*,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
                    onChange={handleFileInputChange}
                    disabled={uploadingDoc}
                  />
                </Label>
                <Button variant="outline" size="sm" onClick={() => setShowUrlDialog(true)} disabled={uploadingDoc}>
                  <Link className="size-4 mr-2" />
                  Add URL
                </Button>
                <span className="text-xs text-muted-foreground hidden md:inline">or drag & drop files below</span>
              </div>
            )}

            {/* Drag & drop zone + file list */}
            <div
              onDrop={canEdit ? handleDrop : undefined}
              onDragOver={canEdit ? handleDragOver : undefined}
              onDragLeave={canEdit ? handleDragLeave : undefined}
              className={cn(
                'rounded-xl border-2 transition-colors min-h-[120px]',
                isDragging
                  ? 'border-brand-ring bg-brand-faint'
                  : 'border-dashed border-border'
              )}
            >
              {project.documents.length === 0 && !isDragging ? (
                <Empty className="py-12 border-none">
                  <EmptyHeader>
                    <EmptyMedia>
                      <FileText className="size-10 text-muted-foreground/40" />
                    </EmptyMedia>
                    <EmptyTitle className="text-base">No files yet</EmptyTitle>
                    <EmptyDescription>
                      Upload PDFs, Word docs, images, or add URLs to build your knowledge base.
                      {canEdit && <span className="block mt-1 text-xs">You can also drag & drop multiple files here.</span>}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : isDragging ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Upload className="size-10 mx-auto text-brand-accent mb-3 animate-bounce" />
                  <p className="text-sm font-medium text-brand-text">Drop files to upload</p>
                </div>
              ) : (
                <div className="p-2 space-y-1.5">
                  {project.documents.map(doc => (
                    <div key={doc.id} className="flex items-center gap-3 rounded-lg border bg-card/60 px-3 py-2 group hover:bg-muted/20 transition-colors">
                      <MimeIcon mimeType={doc.mimeType} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{doc.name}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <DocStatusBadge status={doc.status} />
                          {doc.status === 'ready' && (
                            <span className="text-[10px] text-muted-foreground">{doc.chunkCount} chunks · {(doc.charCount / 1000).toFixed(1)}k chars</span>
                          )}
                          {doc.errorMsg && (
                            <span className="text-[10px] text-destructive truncate">{doc.errorMsg}</span>
                          )}
                        </div>
                      </div>
                      {canEdit && (
                        <button
                          onClick={() => setDeletingDocId(doc.id)}
                          className="p-1.5 rounded-md opacity-60 md:opacity-0 md:group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-destructive transition-all"
                          title="Delete file"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── WORKSPACE TAB (One-Digby Phase 1) ── */}
        {activeTab === 'workspace' && (
          <div className="space-y-4 max-w-xl">
            {ws === undefined ? (
              <div className="py-12 text-center"><Loader2 className="size-5 animate-spin inline text-muted-foreground" /></div>
            ) : wsLoadError ? (
              <LoadErrorState
                message="Couldn't load the workspace status."
                onRetry={() => { setWsLoadError(false); setWs(undefined); }}
              />
            ) : !ws?.provider ? (
              <div className="text-center py-12 space-y-4">
                <FolderGit2 className="size-12 mx-auto text-muted-foreground/40" />
                <div>
                  <h3 className="font-semibold text-lg mb-1">No workspace yet</h3>
                  <p className="text-sm text-muted-foreground">Give this folder a git workspace: uploaded docs get committed as knowledge, and Digby can code in it.</p>
                </div>
                {isOwner && (
                  <div className="space-y-3">
                    <Button disabled={wsBusy} className="bg-send text-send-ink hover:opacity-90 border-0" onClick={async () => {
                      setWsBusy(true);
                      try { setWs(await projectsApi.configureWorkspace(projectId, {})); toast.success('Workspace initialized'); }
                      catch (e: any) { toast.error(e?.response?.data?.error || 'Failed to initialize'); }
                      finally { setWsBusy(false); }
                    }}>
                      {wsBusy ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Plus className="size-4 mr-2" />}
                      Initialize workspace
                    </Button>
                    <div className="flex items-center gap-2 max-w-md mx-auto">
                      <Input placeholder="https://github.com/org/repo.git" value={wsRepoUrl} onChange={e => setWsRepoUrl(e.target.value)} className="text-sm" />
                      <Button variant="outline" disabled={wsBusy || !wsRepoUrl.trim()} onClick={async () => {
                        setWsBusy(true);
                        try { setWs(await projectsApi.configureWorkspace(projectId, { repoUrl: wsRepoUrl.trim() })); toast.success('Repository connected'); }
                        catch (e: any) { toast.error(e?.response?.data?.error || 'Failed to connect'); }
                        finally { setWsBusy(false); }
                      }}>Connect repo</Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="size-4 text-brand-accent" />
                    <span className="font-medium text-sm capitalize">{ws.provider === 'local' ? 'Digby-hosted workspace' : `${ws.provider} repository`}</span>
                    <Badge variant={ws.provisioned ? 'default' : 'outline'} className="ml-auto text-xs">{ws.provisioned ? 'Provisioned' : 'Not provisioned'}</Badge>
                  </div>
                  {ws.repoUrl && <p className="text-xs text-muted-foreground font-mono truncate">{ws.repoUrl}</p>}
                  <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <GitBranch className="size-3" /> {ws.defaultBranch}
                    {ws.knowledgeBranch && <span className="text-muted-foreground/70">· knowledge → {ws.knowledgeBranch}</span>}
                  </p>
                </div>
                {isOwner && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" className="bg-send text-send-ink hover:opacity-90 border-0" disabled={wsBusy} onClick={async () => {
                      setWsBusy(true);
                      try {
                        const sess = await codingApi.createSession(projectId, { title: 'New chat' });
                        router.push(`/?chatId=${sess.id}`);
                      } catch (e: any) { toast.error(e?.response?.data?.error || 'Could not start the chat'); }
                      finally { setWsBusy(false); }
                    }}>
                      <Code2 className="size-3.5 mr-1.5" /> New chat
                    </Button>
                    <Button size="sm" variant="outline" disabled={wsBusy} onClick={async () => {
                      setWsBusy(true);
                      try { const r = await projectsApi.syncWorkspace(projectId); toast.success(`Knowledge synced — ${r.committed} committed, ${r.skipped} skipped`); }
                      catch { toast.error('Sync failed'); }
                      finally { setWsBusy(false); }
                    }}>
                      <RefreshCw className="size-3.5 mr-1.5" /> Sync knowledge
                    </Button>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">Documents uploaded to Files are committed under <code>knowledge/</code>{ws.knowledgeBranch ? ` on ${ws.knowledgeBranch}` : ''} and stay searchable in chat.</p>
              </div>
            )}
          </div>
        )}

        {/* ── MEMBERS TAB ── */}
        {activeTab === 'members' && (
          <div className="space-y-4">
            {/* Invite */}
            {(isOwner || project.role === 'admin') && (
              <div className="rounded-xl border p-4 space-y-3">
                <p className="text-sm font-semibold">Invite member</p>
                <div className="flex gap-2 flex-wrap">
                  <Input
                    placeholder="Email address"
                    value={inviteEmail}
                    onChange={e => setInviteEmail(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleInviteMember()}
                    className="flex-1 min-w-[200px] h-9"
                  />
                  <select
                    value={inviteRole}
                    onChange={e => setInviteRole(e.target.value as 'viewer' | 'editor')}
                    className="h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <Button size="sm" className="h-9" onClick={handleInviteMember} disabled={!inviteEmail.trim() || inviting}>
                    {inviting ? <Loader2 className="size-4 animate-spin mr-1" /> : <UserPlus className="size-4 mr-1" />}
                    Invite
                  </Button>
                </div>
              </div>
            )}

            {/* Owner row */}
            <div className="space-y-2">
              <div className="flex items-center gap-3 rounded-xl border p-3">
                <div className="size-8 rounded-full bg-send flex items-center justify-center text-send-ink text-xs font-bold flex-shrink-0">
                  {(project.userId.charAt(0) || 'O').toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">You (owner)</p>
                </div>
                <Badge className="text-xs bg-active text-ink border-0">Owner</Badge>
              </div>

              {project.members.map(member => (
                <div key={member.userId} className="flex items-center gap-3 rounded-xl border p-3 group">
                  <div className="size-8 rounded-full bg-muted flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {(member.user.name ?? member.user.email).charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{member.user.name ?? member.user.email}</p>
                    <p className="text-xs text-muted-foreground truncate">{member.user.email}</p>
                  </div>
                  <Badge variant="outline" className="text-xs capitalize flex-shrink-0">{member.role}</Badge>
                  {isOwner && (
                    <button
                      onClick={() => handleRemoveMember(member.userId)}
                      className="p-1.5 rounded-md opacity-60 md:opacity-0 md:group-hover:opacity-100 hover:bg-muted text-muted-foreground hover:text-destructive transition-all flex-shrink-0"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── SETTINGS TAB ── */}
        {activeTab === 'settings' && isOwner && (
          <div className="space-y-6 max-w-lg">
            {/* Emoji + Name */}
            <div className="space-y-3">
              <h3 className="font-semibold text-sm">Folder details</h3>
              {/* Emoji picker removed 2026-07-14 (owner: "too busy") — the emoji
                  column persists in the DB but is no longer displayed or edited. */}
              <div className="space-y-1.5">
                <Label className="text-xs">Name</Label>
                <Input value={editName} onChange={e => setEditName(e.target.value)} className="h-9" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Description (optional)</Label>
                <Textarea value={editDescription} onChange={e => setEditDescription(e.target.value)} rows={2} className="resize-none" />
              </div>
            </div>

            <Separator />

            {/* System prompt */}
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Custom Instructions</h3>
              <p className="text-xs text-muted-foreground">These instructions are prepended to every chat in this folder.</p>
              <Textarea
                value={editSystemPrompt}
                onChange={e => setEditSystemPrompt(e.target.value)}
                rows={5}
                placeholder="e.g. You are a marketing expert focused on B2B SaaS. Always provide data-backed answers..."
                className="resize-none"
              />
            </div>

            <Separator />

            {/* Gmail attachment auto-ingest toggle (ticket 99145890) */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h3 className="font-semibold text-sm">Auto-save Gmail attachments</h3>
                <p className="text-xs text-muted-foreground">
                  When on, every Gmail attachment Digby reads in this folder is automatically filed into the
                  folder's knowledge base (text extracted; images described by the vision model — same pipeline
                  as uploaded files). Off by default — turn it on for folders where mail attachments are
                  reference material. Duplicates are skipped (same email + filename = one document), and you
                  can also add one manually from an attachment in chat.
                </p>
              </div>
              <Switch
                checked={autoIngestGmail}
                onCheckedChange={setAutoIngestGmail}
                className="mt-0.5 flex-shrink-0"
              />
            </div>

            {/* Cross-project memory toggle */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h3 className="font-semibold text-sm">Draw on my other folders</h3>
                <p className="text-xs text-muted-foreground">
                  When on, chats in this folder can pull in <span className="font-medium">relevant</span> knowledge
                  from your other folders' documents. Only highly-relevant matches are used, and each is clearly
                  labeled with its source folder. On by default — turn off to keep this folder isolated.
                </p>
              </div>
              <Switch
                checked={editCrossProjectMemory}
                onCheckedChange={setEditCrossProjectMemory}
                className="mt-0.5 flex-shrink-0"
              />
            </div>

            <Separator />

            {/* Fleet-supervision toggle (ticket 3217e287) — same flag as the
                Management dashboard's Supervised column. */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h3 className="font-semibold text-sm">Supervise this folder</h3>
                <p className="text-xs text-muted-foreground">
                  When on, the Fleet Supervisor watches this folder — its chats wake the supervisor on
                  blocked goals and failed runs, and the folder appears in hourly digests and watchdog
                  alerts. On by default — turn off to keep this folder out of fleet supervision.
                </p>
              </div>
              <Switch
                checked={editSupervised}
                onCheckedChange={setEditSupervised}
                className="mt-0.5 flex-shrink-0"
              />
            </div>

            <Button
              className="w-full bg-send text-send-ink hover:opacity-90 border-0"
              onClick={handleSaveSettings}
              disabled={saving}
            >
              {saving ? <Loader2 className="size-4 animate-spin mr-2" /> : <Save className="size-4 mr-2" />}
              Save Changes
            </Button>

            <Separator />

            {/* Project supervisor — immediate toggle (applies on flip, not via
                Save Changes). Distinct from fleet supervision: this folder gets
                its OWN dedicated agent. */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h3 className="font-semibold text-sm">Project supervisor</h3>
                <p className="text-xs text-muted-foreground">
                  A dedicated supervisor agent watches this project's sessions, fans out worker
                  sub-sessions, and reports progress to the Fleet Supervisor. Pausing never
                  deletes its history.
                </p>
                {supervisorChatId && (
                  <p className="text-xs">
                    <span className={supervisorEnabled ? 'text-success' : 'text-muted-foreground'}>
                      {supervisorEnabled ? 'Supervised' : 'Paused'}
                    </span>
                    {' · '}
                    <NextLink href={`/?chatId=${supervisorChatId}`} className="underline underline-offset-2 hover:text-foreground">
                      Open the supervisor chat
                    </NextLink>
                  </p>
                )}
              </div>
              <Switch
                checked={supervisorEnabled}
                onCheckedChange={toggleProjectSupervisor}
                className="mt-0.5 flex-shrink-0"
                aria-label="Project supervisor (dedicated agent for this project)"
                title="Project supervisor (dedicated agent for this project)"
              />
            </div>

            <Separator />

            {/* Auto-archive idle chats (ticket bb86cee8) — immediate select
                (applies on change, not via Save Changes), same pattern as the
                supervisor toggle above. Sits next to Archive: this is the
                automatic hourly version of that manual de-clutter. */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h3 className="font-semibold text-sm">Auto-archive idle chats</h3>
                <p className="text-xs text-muted-foreground">
                  Chats with no activity for this long are archived automatically (checked hourly).
                  Chats with schedules, running coding sessions, or active share links — and
                  supervisor chats — are skipped, and anything archived can be restored from the
                  sidebar’s Archived view.
                </p>
              </div>
              <Select
                value={autoArchiveDays === null ? 'off' : String(autoArchiveDays)}
                onValueChange={(v) => updateAutoArchiveDays(v === 'off' ? null : Number(v))}
              >
                <SelectTrigger
                  className="w-[130px] mt-0.5 flex-shrink-0"
                  aria-label="Auto-archive idle chats"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="7">7 days</SelectItem>
                  <SelectItem value="14">14 days</SelectItem>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                  {/* Read-back honesty: a window set outside the presets (the
                      backend accepts any integer 1..365) still displays. */}
                  {autoArchiveDays !== null && ![7, 14, 30, 90].includes(autoArchiveDays) && (
                    <SelectItem value={String(autoArchiveDays)}>{autoArchiveDays} days</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            {/* Budget & merge policy (capability gap audit #34, 2026-09-24):
                update_project could set both for a while; the owner could not
                see or change them anywhere. Immediate-apply like the rows above. */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h3 className="font-semibold text-sm">Daily spend cap</h3>
                <p className="text-xs text-muted-foreground">
                  USD per trailing 24 hours for this folder’s machine runs. When the cap is reached,
                  scheduled and hook-driven runs wait; your own messages still run. Empty = no cap.
                </p>
              </div>
              <div className="flex items-center gap-1 mt-0.5 flex-shrink-0">
                <span className="text-xs text-muted-foreground">$</span>
                <input
                  id="project-spend-cap"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="1"
                  value={spendCapInput}
                  onChange={(e) => setSpendCapInput(e.target.value)}
                  onBlur={saveSpendCap}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  placeholder="no cap"
                  aria-label="Daily spend cap in USD"
                  className="w-[110px] rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 space-y-1">
                <h3 className="font-semibold text-sm">Machine self-merge</h3>
                <p className="text-xs text-muted-foreground">
                  Whether unattended runs in this folder may merge their own pull requests once the
                  deterministic gates pass. Default follows the platform setting.
                </p>
              </div>
              <Select value={selfMerge} onValueChange={(v) => updateSelfMerge(v as 'on' | 'off' | 'default')}>
                <SelectTrigger className="w-[130px] mt-0.5 flex-shrink-0" aria-label="Machine self-merge policy">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default</SelectItem>
                  <SelectItem value="on">Allowed</SelectItem>
                  <SelectItem value="off">Never</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Separator />

            {/* Archive — reversible de-clutter, deliberately ABOVE the Danger
                Zone (archive first, delete only when it really must go). */}
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Archive</h3>
              <p className="text-xs text-muted-foreground">
                {project.archivedAt
                  ? 'This folder is archived — hidden from the sidebar, nothing deleted.'
                  : 'Hide this folder and its chats from the sidebar without deleting anything. Restore it any time from the sidebar’s Archived section.'}
              </p>
              <Button
                variant="outline"
                className="w-full"
                onClick={project.archivedAt ? handleRestoreProject : handleArchiveProject}
                disabled={archivingProject}
              >
                {archivingProject
                  ? <Loader2 className="size-4 animate-spin mr-2" />
                  : project.archivedAt ? <ArchiveRestore className="size-4 mr-2" /> : <Archive className="size-4 mr-2" />}
                {project.archivedAt ? 'Restore Folder' : 'Archive Folder'}
              </Button>
            </div>

            <Separator />

            {/* Danger zone */}
            <div className="space-y-2">
              <h3 className="font-semibold text-sm text-destructive">Danger Zone</h3>
              <p className="text-xs text-muted-foreground">Permanently delete this folder and all its chats, documents, and chunks.</p>
              <Button
                variant="outline"
                className="w-full text-destructive hover:text-destructive border-destructive/40 hover:border-destructive"
                onClick={() => setShowDeleteProject(true)}
              >
                <Trash2 className="size-4 mr-2" />
                Delete Folder
              </Button>
            </div>
          </div>
        )}
      </main>

      {/* ── Delete Document Confirmation ── */}
      <AlertDialog open={!!deletingDocId} onOpenChange={open => !open && setDeletingDocId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
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

      {/* ── Delete Folder Confirmation ── */}
      <AlertDialog open={showDeleteProject} onOpenChange={setShowDeleteProject}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{project.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the folder, all {project.chats.length} chats, and all {project.documents.length} documents. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProject}
              className="bg-destructive hover:bg-destructive/90"
              disabled={deletingProject}
            >
              {deletingProject ? <Loader2 className="size-4 animate-spin mr-1" /> : null}
              Delete Folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Add URL Dialog ── */}
      <Dialog open={showUrlDialog} onOpenChange={setShowUrlDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="size-4 text-ink-2" />
              Add URL to Knowledge Base
            </DialogTitle>
            <DialogDescription>
              Digby will analyze this URL and store the extracted content in your knowledge base.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">URL</Label>
              <Input
                autoFocus
                placeholder="https://example.com/article"
                value={urlInput}
                onChange={e => setUrlInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddUrl()}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Display name (optional)</Label>
              <Input
                placeholder="e.g. Company Blog Post"
                value={urlName}
                onChange={e => setUrlName(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowUrlDialog(false)}>Cancel</Button>
            <Button
              className="flex-1 bg-send text-send-ink hover:opacity-90 border-0"
              onClick={handleAddUrl}
              disabled={!urlInput.trim() || addingUrl}
            >
              {addingUrl ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
              Analyze
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
