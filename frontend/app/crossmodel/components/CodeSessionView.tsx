'use client';

/**
 * CodeSessionView — the coding experience as a COMPONENT of the main chat page
 * (One-Digby consolidation C3, 2026-07-15). Replaces the standalone
 * /crossmodel/code page: the main sidebar owns navigation; this renders the
 * session header, agent transcript, composer, and the Overview workspace panel
 * for a chat that is code-CAPABLE (P5-B: satellite attached or folder-chain
 * workspace — the retired mode === 'code' marker is gone). Ported from code/page.tsx (now deleted).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  codingApi, CodingProject, CodingSession, CodingMessage, MessagePart, PermissionMode,
  CodingPlan, PlanStep, TodoStatus, PREVIEW_CROSS_ORIGIN, ChatImage, modelSupportsVision,
} from '@/lib/api/coding';
import { crossModelApi, canvasApi, projectsApi, getWorktreeFile, downloadWorktreeFile, type PendingConfirmation } from '@/lib/api/crossmodel';
import OwnerQuestionCard from './OwnerQuestionCard';
import { pendingQuestionFromEvent, composeMultiSelectAnswer, type PendingQuestion } from '@/lib/ask-user-question';
import { isPlaceholderChatTitle } from '@/lib/chat-title';
import { modelEndpointsApi, isChatCapableModel } from '@/lib/api/model-endpoints';
import { DigbyLoader } from '@/components/ui/custom/DigbyLoader';
import { useBranding } from '@/app/branding/BrandingProvider';
import { ensureFreshAuthCookie } from '@/lib/api-client';
import { formatMessageTime } from '@/lib/format-message-time';
import { decideTranscriptPin, followTarget, NEAR_BOTTOM_PX, turnAnchorIndex } from '@/lib/transcript-pin';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { routeSend, classifySteerFailure } from '@/lib/composer-guard';
import { drainAction, isProvisionQueueId, loadProvisionQueue, makeQueued, mergeIntoInitial, mergeQueued, saveProvisionQueue, PROVISION_QUEUE_CAPTION, type ProvisionQueued } from '@/lib/provision-queue';
import { partitionQueuedEchoes, reconcileQueuedEchoes, reconcilePendingEchoes, isPlainQueueEchoId } from '@/lib/queued-echoes';
import { createSnapshotStore } from '@/lib/plain-transcript-snapshot';
import { GUEST_QUEUE_CAPTION, guestDrainAction, isGuestQueueId, makeGuestQueued, mergeGuestQueued, stageChatlessBehindLive, type GuestQueuedSend } from '@/lib/guest-send-queue';
import { interleaveSteers } from '@/lib/steer-interleave';
import { moveItem, queueFromError, queueRefusalMessage, refusalCodeFromError, withPositions, type QueuedItem } from '@/lib/queue-controls';
import QueuedMessagesPanel from './QueuedMessagesPanel';
import { dedupById } from '@/lib/transcript-dedup';
import { errorToastSignature, shouldToastError } from '@/lib/error-toast-dedup';
import { displayModelId } from '@/lib/model-alias';
import { usePreferences, TEXT_SIZE_MAP } from '@/lib/preferences';
import { buildPlainStreamUrl, buildPlainAttachUrl, buildPlainMeta, canvasEventToText, fetchPlainRunActive, isPlainTeammateMessage, makeLegacyNormalizer, mapPlainMessages, mapPlainPendingMessages, markCheckInterrupted, plainRevisionPending, pollPlainRevision, settleRestoredRows, stripLiveTags, PlainAttachmentRef } from '../plain-session';
import { fetchGuestSessionState, guestResumeLiveState, guestResumeNeeded, guestResumeRowPick, resumeGuestSession } from '../guest-resume';
import { applyEscalationRefusal, chipAnchorId, composerRunAffordance, escalationRefusalPlan, guestHydratedRow, pendingRowsToPoll, settleRowsInterrupted, type InFlightEscalation, type LiveRunSource } from '../depth-ux-seams';
import type { PlainModeSource } from '@/lib/depth-ux';
import { ESCALATE_LABEL, countSpentEscalations, escalationChipFor, pillFromMeta, reduceCheckState, type CheckState, type DepthQuotaView } from '@/lib/depth-ux';
import { DepthChipRow, DepthPill, HowDigbyAnswered, TransparencyPill } from './DepthPill';
import { buildHowRows } from '@/lib/answer-transparency';
import { attachCanvasesToMessages } from '@/lib/canvas-attach';
import CanvasInlineCard from './CanvasInlineCard';
import { sendUxBeacon } from '@/lib/ux-beacon';
import { createStreamDropTracker, type StreamDropContext } from '@/lib/stream-drop-beacon';
import { buildGuestAttachUrl, guestReconnectSessionId, onlineResyncDisabled, reconnectBackoff } from '../guest-reconnect';
import { ESCALATION_REFUSAL_CODES, escalationRefusalFor } from '@/lib/depth-ux';
import { mergeDeltaIntoParts } from '@/lib/reasoning-merge';
import { trimTrailingTextParts, appendGuardMarkerParts, upsertTaskPartParts } from '@/lib/transcript-parts';
import { TaskCardActionsContext, TaskResultSection, type TaskCardActions } from './TaskCard';
import { TASK_EVENT_TYPE, applyTaskToMessages, findSessionResult, messagesHaveTask, mergeChildSessionIntoTask, parseTaskEvent, pendingTasksOf, tasksOfMessage } from '@/lib/task-card';
import { imagePartFromFrame } from '@/lib/image-frame-part';

/** Progress stages that bypass the status-line throttle — harness verdicts a viewer must see (2026-09-08). */
const URGENT_PROGRESS_STAGES: ReadonlySet<string> = new Set(['zero-tool-gate', 'evidence-guard', 'leak', 'deadline', 'loop', 'resume', 'steer', 'event-log-degraded', 'truncated']);
import {
  AssistantParts, CodeTranscriptMarkdown,
  parseEmailDraft, extractEmailFromParts, PlainEmailCard, PlainSourcesRow, PlainFollowUps, PlainModelCard, PlainMessageActions, UserMessageCopyButton,
} from './code-transcript';
import { ElapsedTimer, LiveRunStatus, StreamingDot, ThinkingBlock, appendThinkingStep, liveHasText } from './LiveRunStatus';
import { StreamingWordsContext } from '@/lib/stream-words-context';
import WorkspacePanel, { openWorkspaceSection, type WorkspaceSection } from './WorkspacePanel';
import { workspaceSectionIds, WORKSPACE_SECTION_LABELS } from '@/lib/workspace-sections';
import { BrowserActivityView, BrowserBottomSheet } from './BrowserPanel';
import {
  EMPTY_BROWSER_ACTIVITY, CLOSED_BROWSER_SHEET, reduceBrowserActivity, nextBrowserSheetState, seedBrowserActivityFromMessages,
  browserPageLabel, type BrowserActivityState, type BrowserSheetState,
} from '@/lib/browser-activity';
import CanvasPanel, { CanvasItem } from './CanvasPanel';
import ChatFilesSection from './ChatFilesSection';
import FilesPane from './FilesPane';
import CodingFilesTabs from './CodingFilesTabs';
import { WORKTREE_CANVAS_PREFIX } from './WorktreeTree';
import { WorktreeOpenContext } from '@/lib/worktree-open-context';
import SchedulesSection, { ScheduleCountLine } from './SchedulesSection';
import { SessionProjectPulse } from './ProjectPulse';
import { ResizeHandle } from '@/components/ui/custom/resize-handle';
import { useResizable } from '@/lib/use-resizable';
import { usePolling } from '@/lib/use-polling';
import ChatComposer, { COMPOSER_ATTACH_BTN, COMPOSER_TOOL_BTN, SEND_BTN } from './ChatComposer';
import GhostComposerToggle from './GhostComposerToggle';
import { AttachmentChips, uploadChatFiles, type AttachmentInfo } from './attachments';
import MachineWakeBlock from './MachineWakeBlock';
import MachineTurnGroup from './MachineTurnGroup';
import MachineBundle from './MachineBundle';
import AgentMessageCard from './AgentMessageCard';
import MessageNavigator, { navPreview } from './MessageNavigator';
import { TranscriptAttachmentChips } from '@/components/ui/custom/prompt/transcript-attachment-chips';
import { ExpandableDataImage } from '@/components/ui/custom/prompt/expandable-data-image';
import { classifyAssistantCard, classifySystemRow } from '@/lib/machine-wake';
import { bundleMachineGroups, groupMachineRows, type MachineTurnGroup as MachineTurnGroupItem } from '@/lib/machine-turn-grouping';
import ThinkingAd from './ThinkingAd';
import type { ChatComposerHandle } from './ChatComposerTextarea';
import { useVoiceComposer } from './use-voice-composer';
import type { CodingChrome } from './FloatingChrome';
import { reasoningVisible } from '@/lib/reasoning-visibility';
import { replayedRunStart } from '@/lib/run-clock';
import { ChatOpenContext } from '@/lib/chat-open-context';
import { supervisorPanelFor, type SupervisorPanelTarget } from '@/lib/supervisor-panel';
import { ProjectSupervisorPanel } from './supervisor-panel/ProjectSupervisorPanel';
import { FleetSupervisorPanel } from './supervisor-panel/FleetSupervisorPanel';
import { completePartsOmitted } from '@/lib/complete-event';
import { codingActionRowFor } from '@/lib/coding-feedback';
import { useMinimalView, isMinimalHidden, minimalNoteLabel, groupMinimalNotes } from '@/lib/view-mode';
import { MinimalNoteLine } from './MinimalNoteLine';

import {
  Plus, Loader2, GitBranch, FolderGit2, ChevronDown, ShieldCheck, X, Check,
  ListChecks, CheckCheck, Play, Target, Pencil, Trash2,
  Circle, CircleDot, CheckCircle2, Ban, Lock, Eye, RefreshCw, ExternalLink, Gauge, Users, HelpCircle,
  CalendarClock, FileText, Mic, MicOff, Brain, Globe, ArrowUp, LayoutDashboard, Network,
} from 'lucide-react';

interface PendingApproval { approvalId: string; tool: string; args: any; }

/** Format a remaining-ms countdown: "1h 04m" above an hour, else "47:12". */
function fmtQuestionCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Extension → canvas code-language for the read-only worktree viewer's type
 *  badge (mirrors CanvasPanel's getFileExtension map, inverted). null = plain. */
function worktreeLanguageForPath(path: string): string | null {
  const ext = (path.split('.').pop() || '').toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift',
    sql: 'sql', sh: 'bash', bash: 'bash', zsh: 'bash',
    css: 'css', scss: 'css', html: 'html', htm: 'html',
    md: 'markdown', markdown: 'markdown', json: 'json',
    yml: 'yaml', yaml: 'yaml', c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    cs: 'csharp', php: 'php', rb: 'ruby',
  };
  return map[ext] ?? null;
}
interface LiveWorker { role: string; title: string; done: boolean; }
interface ProcRow { handle: string; name: string; command: string; status: 'running' | 'exited'; exitCode: string | null; port?: number; startedAt?: number; }
interface LiveLoop { kind: string; round: number; max: number; detail?: string; }
interface AgentUsageRow { agent: string; role?: string; model: string; inTokens: number; outTokens: number; costUsd: number; turns: number; estimated: boolean; }
interface RunUsage { runId?: string; totalInTokens: number; totalOutTokens: number; totalCostUsd: number; turns: number; estimated: boolean; agents: AgentUsageRow[]; }
/** Durable whole-session totals — computed and persisted server-side. */
interface SessionUsage { inTokens: number; outTokens: number; costUsd: number; turns: number; runs: number; estimated: boolean; agents: AgentUsageRow[]; }
interface LiveContext { chars: number; budget: number; compactions: number; usage?: RunUsage; }
interface VerifyStage { key: string; passed: boolean; }
interface LiveVerify { stages: VerifyStage[]; running: boolean; passed?: boolean; failedStage?: string | null; }
interface LiveRun {
  parts: MessagePart[];
  pendingApproval: PendingApproval | null;
  pendingQuestion?: PendingQuestion | null;
  running: boolean;
  /** What backs `running` (depth-ux-seams.ts LiveRunSource): unset/'stream' =
   *  a live SSE stream is attached in this tab; 'poll' = a polled resume
   *  (guest-resume.ts) — nothing attached here, so the composer shows no
   *  Stop / queue chrome (owner 2026-09-27). Only guestResumeLiveState() sets it. */
  source?: LiveRunSource;
  stopping?: boolean;
  workers?: LiveWorker[];
  context?: LiveContext;
  status?: string;
  /** Digby Frontier thinking steps: the distinct progress lines this turn has
   *  shown, oldest first (capped) — the "Thinking" step list before the first
   *  token. Reset with `status`. */
  steps?: string[];
  verify?: LiveVerify;
  /** Background processes/monitors — OUTLIVE runs (a dev server keeps serving). */
  processes?: ProcRow[];
  loop?: LiveLoop;
  /** Depth UX (2026-09-26): the harness's last `check_state` for the streaming
   *  turn — the pill under the live bubble; folded into the appended
   *  message's plainMeta.check at complete (the normalizer carries it).
   *  Cleared at every run start / full-replay attach / complete reset so the
   *  PREVIOUS turn's pill never renders under the next streaming answer. */
  check?: CheckState;
}

const MAX_LIVE_PARTS = 400;

// 0c158104: per-chat SSE resume cursors. Every coding-stream frame carries a
// composite `<runId>:<seq>` SSE id; remembering the last one rendered lets a
// re-attach (refocus, reconnect) ask the server for ONLY the events past it
// (after_seq) instead of re-fetching the whole run log. MEMORY-ONLY on
// purpose: a full page reload or chat switch zeroes the live parts, and a
// cursor resume there would rebuild just the TAIL of the in-flight turn —
// those paths must keep the full replay (the transcript's only source).
const streamSeqMemory = new Map<string, string>();
// Ticket 017f090b (review F1): only persisted crossModelMessage row ids are valid
// feedback messageIds — fresh/streamed rows carry a-${Date.now()} / tmp- / m-${i}-
// placeholder ids that the feedback schema (z.string().uuid()) would 400 on.
const CROSSMODEL_MSG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noteStreamSeq(chatId: string, cursor: string): void {
  streamSeqMemory.set(chatId, cursor);
}
function storedStreamSeq(chatId: string): string | undefined {
  return streamSeqMemory.get(chatId);
}
function clearStreamSeq(chatId: string): void {
  streamSeqMemory.delete(chatId);
}

/** Transcript page size for the coding session GET (server paging, 2026-08-31 —
 *  the coding transcript used to load in FULL on every open/resync). */
const CODING_PAGE = 50;
/** Hard ceiling on rendered transcript rows (each is markdown + shiki) — "Load
 *  earlier" stops here so a deep scroll-back can't wedge live-run re-renders. */
const MAX_VISIBLE = 200;

// 2026-08-31 session-open perf: module-level snapshot of the last viewed state
// per coding chat. A remount (chat switch — key={chatId} wipes ALL component
// state) renders the snapshot instantly and revalidates in the background
// instead of spinlocking on the transcript GET. MEMORY-ONLY (same lifetime
// argument as streamSeqMemory) and bounded to the last few chats.
interface SessionViewSnapshot {
  at: number;
  session: CodingSession & { project?: CodingProject };
  project: CodingProject | null;
  messages: CodingMessage[];
  paging: { hasMore: boolean; cursor: string | null };
  sessionUsage: SessionUsage | null;
}
const SESSION_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const SESSION_SNAPSHOT_MAX = 5;
const sessionSnapshots = new Map<string, SessionViewSnapshot>();
function readSessionSnapshot(chatId: string): SessionViewSnapshot | null {
  const snap = sessionSnapshots.get(chatId);
  if (!snap) return null;
  if (Date.now() - snap.at > SESSION_SNAPSHOT_TTL_MS) { sessionSnapshots.delete(chatId); return null; }
  return snap;
}
function writeSessionSnapshot(chatId: string, snap: Omit<SessionViewSnapshot, 'at'>): void {
  sessionSnapshots.delete(chatId); // re-insert at the tail = most-recently-written
  sessionSnapshots.set(chatId, { ...snap, at: Date.now() });
  while (sessionSnapshots.size > SESSION_SNAPSHOT_MAX) {
    const oldest = sessionSnapshots.keys().next().value;
    if (oldest === undefined) break;
    sessionSnapshots.delete(oldest);
  }
}

/** Drop a chat's cached transcript snapshot (owner 2026-10-27 stale-delete UI
 *  report). The module-level cache survives CodeSessionView's key={chatId}
 *  remount, so without an explicit purge a deleted chat re-opens (deep link,
 *  dashboard row click) from its cached transcript — the deleted session
 *  "still sits" in the view until the first GET 404s. Called by the PAGE on
 *  delete/archive/SSE-notice, so it is exported (default-importable). */
export function purgeSessionSnapshot(chatId: string): void {
  sessionSnapshots.delete(chatId);
  // Ticket ce78ab80: the PLAIN transcript cache shares this purge — every
  // delete/archive/terminal-404 path that drops a coding snapshot must drop a
  // plain one, or a deleted plain chat re-opens from its cached transcript.
  plainTranscriptSnapshots.drop(chatId);
}

// Ticket ce78ab80 (owner report 2026-11-04: "everytime i navigate away from
// chats and then back i have to wait so long for chats to load? arent they in
// cache or anything ?"): the PLAIN half of the snapshot above. Plain chats had
// NO cache — the load effect zeroed the transcript and then waited on a
// blocking getChat(50), so every re-open was an empty screen plus a full round
// trip, while coding sessions painted instantly. Same lifetime rules as the
// coding snapshot (MEMORY-ONLY, TTL'd, bounded) and the same revalidate-behind
// discipline; the store itself is lib/plain-transcript-snapshot.ts so its TTL
// and eviction are unit-tested instead of pinned as source text.
const plainTranscriptSnapshots = createSnapshotStore<CodingMessage>();

/** Write a plain chat's snapshot from a transcript the SERVER just confirmed.
 *  Every call site passes the rows it is committing right now — never a prior
 *  snapshot — so the cache can only ever hold content the server has served. */
function rememberPlainTranscript(
  chatId: string,
  messages: CodingMessage[],
  paging: { hasMore: boolean; cursor: string | null },
  pendingIds: Iterable<string>,
  supervisorChat: boolean,
): void {
  plainTranscriptSnapshots.write(chatId, {
    messages,
    paging,
    pendingIds: Array.from(pendingIds),
    supervisorChat,
  });
}

/** Refresh the ROWS of an existing plain snapshot after a server-confirmed
 *  transcript change (review MAJOR-2 on ticket ce78ab80): a completed turn is
 *  appended to the live view and persisted by the server, so a re-open inside
 *  the TTL would otherwise paint the transcript WITHOUT the answer that just
 *  arrived — "my reply is missing" for a moment, the mirror of the bug the
 *  snapshot exists to fix. Paging/queue/supervisor fields are preserved (they
 *  did not change); a chat with no snapshot stays uncached (nothing to keep
 *  fresh, and the next open is an honest cold load). */
function refreshPlainSnapshotMessages(chatId: string, messages: CodingMessage[]): void {
  const snap = plainTranscriptSnapshots.read(chatId);
  if (!snap) return;
  rememberPlainTranscript(chatId, messages, snap.paging, snap.pendingIds, snap.supervisorChat);
}

// Local-only echo rows (optimistic sends/steers, the just-completed assistant
// append) carry client-minted ids — never server row ids. A transcript refetch
// now MERGES the newest page into the loaded history (older prepended pages
// must survive) instead of replacing it, so these are stripped before merging:
// the persisted row arrives in the page and an un-stripped echo would linger
// as a duplicate forever.
const LOCAL_ECHO_ID_RE = /^(tmp-|steer-|a-\d+$|m-\d+-)/;

/** Union the freshest server page into the loaded transcript by row id (page
 *  wins — the in-flight assistant row's parts/content refresh), dropping
 *  local-only echoes, chronological by (createdAt, id). */
/**
 * Coding transcript rows arrive with their server `metadata` (2026-09-15 —
 * provenance stamps on machine-run finals, harness status cards). The plain
 * path maps CrossModelMessage.metadata → plainMeta in mapPlainMessages; this
 * is the coding-side twin so classifySystemRow / classifyAssistantCard /
 * groupMachineRows read ONE field on both surfaces. A row that already has
 * plainMeta (local echoes, plain rows) is left alone.
 */
function bridgeCodingMeta(rows: CodingMessage[]): CodingMessage[] {
  return rows.map((m) => (!m.plainMeta && m.metadata && typeof m.metadata === 'object' ? { ...m, plainMeta: m.metadata } : m));
}

// Owner report 2026-09-16 ("I don't visually see my queued messages in coding
// sessions like I used to"): the merge used to drop EVERY local echo, so a
// mid-run re-attach (tab switch, network blip, deploy flip) erased the queued
// bubble while the server's eager steer row landed ABOVE the live block.
// reconcileQueuedEchoes re-keys a pending echo to its server twin instead
// (lib/queued-echoes.ts) — the caller re-keys pendingSteerIds via idMap.
function mergeLatestTranscriptPage(prev: CodingMessage[], page: CodingMessage[], pendingIds: ReadonlySet<string>): { messages: CodingMessage[]; idMap: Map<string, string> } {
  return reconcileQueuedEchoes(prev, page, pendingIds, { isLocalEcho: (id) => LOCAL_ECHO_ID_RE.test(id) });
}
// Plain twin of the merge above (owner report 2026-09-18, "when I send a
// message and it queues it disappears but shows the toast, then later on
// reappears"): a plain busy-queue message lives in the server's
// pending_chat_messages until the drain RUNS it — it is NOT in the chat's
// message list — so reloadPlain's wholesale replace dropped the `tmp-*` echo
// on every transcript reload while the run was live (window focus resync,
// re-attach, stop) and the bubble came back only when the drained turn's
// user row landed. The merge keeps a pending echo without a twin; the twin
// may be arbitrarily NEWER (persisted at drain time), never older.
function mergeLatestPlainPage(prev: CodingMessage[], page: CodingMessage[], pendingIds: ReadonlySet<string>): { messages: CodingMessage[]; idMap: Map<string, string> } {
  return reconcileQueuedEchoes(prev, page, pendingIds, {
    isLocalEcho: (id) => LOCAL_ECHO_ID_RE.test(id),
    windowBeforeMs: 60_000,
    windowAfterMs: Number.POSITIVE_INFINITY,
    // Ticket c0b2b0c8: `pending-<rowId>` rows come from the GET's
    // pendingMessages (the server-side queue). The fresh page is the source
    // of truth for which queue entries still exist — a prev pending row the
    // page no longer lists has been drained into a persisted row, and
    // keeping it would duplicate that row. (Coding path never passes this:
    // its steers are persisted eagerly, not queued.)
    dropPrevAbsent: (id) => id.startsWith('pending-'),
  });
}

const MSG_WINDOW = 20;
const MODE_LABEL: Record<PermissionMode, string> = { auto: 'Auto', plan: 'Plan', ask: 'Ask' };

const fmtTok = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
const fmtUsd = (n: number) => n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
// ElapsedTimer (the isolated 1 s clock) lives in ./LiveRunStatus with the live
// bubble's status row since 2026-09-27 — imported above.

// ── Overview section (project info · context · goal · todos · preview) ───────
const TODO_ICON: Record<TodoStatus, typeof Circle> = {
  pending: Circle, in_progress: CircleDot, completed: CheckCircle2, blocked: Ban,
};
const TODO_ICON_COLOR: Record<TodoStatus, string> = {
  pending: 'text-muted-foreground', in_progress: 'text-ink-2', completed: 'text-success-accent', blocked: 'text-warn-ink',
};
const NEXT_STATUS: Record<TodoStatus, TodoStatus> = {
  pending: 'in_progress', in_progress: 'completed', completed: 'pending', blocked: 'pending',
};

function ProviderBadge({ provider }: { provider: string }) {
  const label = provider === 'github' ? 'GitHub' : provider === 'blank' ? 'Blank' : provider === 'git' ? 'Git URL' : provider;
  return <span className="text-[12px] border border-border rounded px-1.5 py-0.5 text-ink-3">{label}</span>;
}

/** Project-level coding AGENT picker (owner ask 2026-09-04): writes the
 *  folder's codingModel setting via the projects API. The override wins over
 *  the session's stamped model on the NEXT run (run-executor swap), so
 *  changing it here re-points EXISTING sessions in this folder too. Options:
 *  built-ins + [coding]-flagged registry endpoint models (the registry list
 *  is ADMIN-only — a 403 just keeps the built-in list). Editors+; a viewer's
 *  save 404s server-side and toasts. */
const AGENT_PICKER_BUILT_INS = ['glm-5.3', 'deepseek-flash', 'kimi-k3'];
function ProjectAgentPicker({ projectId, sessionModel }: { projectId: string; sessionModel: string }) {
  const [value, setValue] = useState<string | null>(null); // null = loading → static fallback
  const [registry, setRegistry] = useState<Array<{ id: string; name: string }>>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setValue(null);
    projectsApi.get(projectId)
      // Display-normalize a stored LEGACY pick (glm-5.2, deepseek-v4-pro…) so it
      // selects its current option instead of falling to "Default"; writes are
      // unchanged (the run path aliases the stored id forward itself).
      .then(d => { if (alive) setValue(displayModelId((d as any).codingModel || '')); })
      .catch(() => { if (alive) setValue(''); });
    modelEndpointsApi.list()
      .then(eps => {
        if (!alive) return;
        setRegistry(eps.filter(e => e.enabled).flatMap(e =>
          // 2026-09-27: every CHAT-capable model (kind: chat), not only the legacy [coding] flag.
          e.models.filter(m => isChatCapableModel(m)).map(m => ({ id: `${e.label}:${m.id}`, name: `${e.label} · ${m.displayName || m.id}` }))));
      })
      .catch(() => { /* non-admin (403) or offline — built-ins only */ });
    return () => { alive = false; };
  }, [projectId]);
  const save = async (next: string) => {
    const prev = value;
    setValue(next);
    setSaving(true);
    try {
      await projectsApi.update(projectId, { codingModel: next });
      toast.success(next ? 'Folder coding agent updated — applies from the next run' : 'Folder coding agent reset to the default');
    } catch (err: any) {
      setValue(prev);
      toast.error(err?.response?.data?.error || 'Failed to update the coding agent');
    } finally {
      setSaving(false);
    }
  };
  if (value === null) return <dd className="truncate">{sessionModel}</dd>;
  return (
    <dd className="min-w-0">
      <select
        value={value}
        onChange={e => save(e.target.value)}
        disabled={saving}
        aria-label="Folder coding agent"
        title="The coding agent for this folder — the override applies to every session here from its next run."
        className="w-full max-w-[170px] h-6 rounded border border-border bg-transparent px-1 text-xs truncate"
      >
        <option value="">Default ({sessionModel})</option>
        <optgroup label="Built-in models">
          {AGENT_PICKER_BUILT_INS.map(id => <option key={id} value={id}>{id}</option>)}
        </optgroup>
        {registry.length > 0 && (
          <optgroup label="Custom endpoints">
            {registry.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
          </optgroup>
        )}
      </select>
    </dd>
  );
}

const STATUS_DOT: Record<string, string> = {
  ready: 'bg-success-accent', running: 'bg-send', provisioning: 'bg-warn', error: 'bg-destructive', archived: 'bg-muted-foreground',
};

// ── Schedules (rm9): the rows moved to the workspace panel's Schedules TAB
// (SchedulesSection.tsx — both session kinds, cancel/pause without asking).
// Overview keeps only ScheduleCountLine, a one-line "N schedules → Schedules
// tab" pointer, so there is exactly ONE source of truth for schedule rows.

export function OverviewPanel({
  project, session, plan, running, context, sessionUsage, lastAdded, processes, loop,
  previewHint, previewDefaultPort, showSchedulesLink = true,
  onAddTodo, onCycleTodo, onDeleteTodo, onSaveGoal,
}: {
  project: CodingProject | null;
  session: CodingSession;
  plan: CodingPlan | null;
  running: boolean;
  context?: LiveContext;
  sessionUsage?: SessionUsage | null;
  lastAdded?: number;
  processes?: ProcRow[];
  loop?: LiveLoop;
  /** Live "the agent just brought a dev server up on this port" signal. */
  previewHint?: { port: number; ts: number } | null;
  /** Persisted port from an earlier run (seeds the input; doesn't auto-load). */
  previewDefaultPort?: number | null;
  /** rm9: the "N schedules → Schedules tab" pointer — false when the mount has
      no Schedules tab to point at (kid accounts: the registry withholds it). */
  showSchedulesLink?: boolean;
  onAddTodo: (text: string) => void;
  onCycleTodo: (step: PlanStep) => void;
  onDeleteTodo: (step: PlanStep) => void;
  onSaveGoal: (goal: string) => void;
}) {
  // Minimal view (2026-10-16): no model, context / token / cost figures, loops or background processes.
  const minimal = useMinimalView();
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const [newTodo, setNewTodo] = useState('');
  const [previewPort, setPreviewPort] = useState('3000');
  const [loadedPort, setLoadedPort] = useState<number | null>(null); // snapshot at Load — iframe src must not track keystrokes
  const [previewOn, setPreviewOn] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(1);

  // Seed the port from a persisted agent-configured value (no auto-load).
  useEffect(() => {
    if (previewDefaultPort) setPreviewPort(String(previewDefaultPort));
  }, [previewDefaultPort]);
  // A LIVE preview_ready configures AND loads the preview — the user does nothing.
  useEffect(() => {
    if (!previewHint) return;
    setPreviewPort(String(previewHint.port));
    setLoadedPort(previewHint.port);
    setPreviewOn(true);
    setPreviewNonce(n => n + 1);
  }, [previewHint]);
  const steps = plan?.steps ?? [];
  const done = steps.filter(s => s.status === 'completed').length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  const locked = running;

  const startEditGoal = () => { setGoalDraft(plan?.goal || ''); setEditingGoal(true); };
  const saveGoal = () => { onSaveGoal(goalDraft.trim()); setEditingGoal(false); };
  const submitTodo = () => { const t = newTodo.trim(); if (t) { onAddTodo(t); setNewTodo(''); } };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* No own header/close row — WorkspacePanel's tab strip + X own the
          panel chrome for every section (one close affordance per panel). */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4 text-sm">
        {/* Project pulse (owner scoping principle 2026-09-07): moved here from
            the removed global Fleet tab — the panel pertains to THIS session,
            so the pulse follows the session's OWN project. Dashboard project
            titles + the project page keep their pulse blocks (owner-approved
            global surfaces). */}
        {session.projectId && (
          <section className="space-y-2">
            <h3 className="text-[12px] font-medium text-ink-3">Project pulse</h3>
            <SessionProjectPulse projectId={session.projectId} className="rounded-lg border border-border bg-muted/30 p-2.5" />
          </section>
        )}
        <section className="space-y-2">
          <h3 className="text-[12px] font-medium text-ink-3">Folder</h3>
          <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-1.5">
            <div className="flex items-center gap-1.5 font-medium">
              <FolderGit2 className="size-4 text-brand-accent shrink-0" />
              <span className="truncate flex-1">{project?.name || 'Folder'}</span>
              {project && <ProviderBadge provider={project.provider} />}
            </div>
            <dl className="text-xs space-y-1 text-muted-foreground">
              <div className="flex items-center gap-1.5"><GitBranch className="size-3 shrink-0" /><span className="font-mono truncate">{session.branch}</span></div>
              <div className="flex justify-between gap-2"><dt>Base</dt><dd className="font-mono truncate">{session.baseBranch}</dd></div>
              {/* displayModelId: sessions stamped before a model cutover store the LEGACY id (e.g. glm-5.2) — show the current one. */}
              {!minimal && <div className="flex justify-between gap-2 items-center"><dt>Agent</dt><ProjectAgentPicker projectId={session.projectId} sessionModel={displayModelId(session.model)} /></div>}
              <div className="flex justify-between gap-2"><dt>Mode</dt><dd>{MODE_LABEL[session.permissionMode]}</dd></div>
              <div className="flex justify-between gap-2 items-center"><dt>Status</dt>
                <dd className="flex items-center gap-1.5"><span className={cn('size-2 rounded-full', STATUS_DOT[session.status] || 'bg-muted-foreground')} />{session.status}</dd>
              </div>
            </dl>
          </div>
        </section>

        {!minimal && <section className="space-y-2">
          <h3 className="text-[12px] font-medium text-ink-3">Context</h3>
          <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-2">
            {context ? (() => {
              const cpct = Math.min(100, Math.round((context.chars / Math.max(1, context.budget)) * 100));
              const barColor = cpct >= 90 ? 'bg-destructive' : cpct >= 70 ? 'bg-warn' : 'bg-success-accent';
              return (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground"><Gauge className="size-3.5" /> Window used</span>
                    <span className="font-mono">{cpct}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${cpct}%` }} />
                  </div>
                  {context.compactions > 0 && (
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <RefreshCw className="size-3 shrink-0" /> Auto-compacted {context.compactions}× this run
                    </div>
                  )}
                </>
              );
            })() : (
              <p className="text-[11px] text-muted-foreground leading-snug">
                The transcript is auto-compacted to stay within the model’s context window. Live usage shows here while the agent runs.
              </p>
            )}
            {(context?.usage || (sessionUsage && (sessionUsage.inTokens > 0 || sessionUsage.outTokens > 0))) && (() => {
              const u = context?.usage;
              const s = sessionUsage;
              const est = (u?.estimated || s?.estimated) ?? false;
              // Per-agent breakdown: the DURABLE whole-session rows (every
              // subagent, every run) — fall back to the live run's rows before
              // the first commit lands.
              const agents = (s?.agents?.length ? s.agents : u?.agents) || [];
              return (
                <div className="pt-2 border-t border-border/60 space-y-1.5">
                  {u && running && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">This run</span>
                      <span className="font-mono">
                        {fmtTok(u.totalInTokens)} in · {fmtTok(u.totalOutTokens)} out
                        {lastAdded ? <span className="text-success-accent"> +{fmtTok(lastAdded)}</span> : null}
                      </span>
                    </div>
                  )}
                  {s && (s.inTokens > 0 || s.outTokens > 0) && (
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Session total{s.runs > 1 ? ` (${s.runs} runs)` : ''}</span>
                      <span className="font-mono">{fmtTok(s.inTokens)} in · {fmtTok(s.outTokens)} out · ~{fmtUsd(s.costUsd)}</span>
                    </div>
                  )}
                  {agents.length > 0 && (
                    <div className="space-y-0.5 pt-1">
                      {agents.map(a => (
                        <div key={`${a.agent}-${a.model}`} className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span className="truncate flex items-center gap-1">
                            <Users className="size-3 shrink-0 opacity-60" />
                            <span className="truncate">{a.agent}</span>
                            <span className="opacity-60 shrink-0">· {a.model}</span>
                          </span>
                          <span className="font-mono shrink-0">{fmtTok(a.inTokens + a.outTokens)} · ~{fmtUsd(a.costUsd)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground/70 leading-snug">Rough estimate at published list prices{est ? ' (some turns estimated from length)' : ''}.</p>
                </div>
              );
            })()}
          </div>
        </section>}

        {!minimal && (processes?.length || loop) && (
          <section className="space-y-2">
            <h3 className="text-[12px] font-medium text-ink-3 flex items-center gap-1.5"><Play className="size-3.5 text-brand-accent" /> Running</h3>
            <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-1.5">
              {loop && (
                <div className="flex items-center gap-1.5 text-[11px]">
                  <RefreshCw className="size-3 text-ink-2 shrink-0" />
                  <span className="font-medium">{loop.kind === 'goal-continue' ? 'Auto-continue' : 'Auto-verify'} loop</span>
                  <span className="text-muted-foreground">round {loop.round}/{loop.max}{loop.detail ? ` · ${loop.detail}` : ''}</span>
                </div>
              )}
              {(processes || []).map(p => (
                <div key={p.handle} className="flex items-center gap-2 text-xs">
                  <span className={cn('size-2 rounded-full shrink-0', p.status === 'running' ? 'bg-success-accent animate-pulse' : 'bg-muted-foreground')} />
                  <span className="font-mono truncate flex-1" title={p.command}>{p.name}</span>
                  {p.port && <span className="text-[10px] font-mono border border-border rounded px-1 text-muted-foreground shrink-0">:{p.port}</span>}
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                    {p.status === 'running'
                      ? (p.startedAt ? <ElapsedTimer since={p.startedAt} /> : 'running')
                      : `exit ${p.exitCode ?? '?'}`}
                  </span>
                </div>
              ))}
              {!processes?.length && loop && <p className="text-[10px] text-muted-foreground/70 m-0">No background processes.</p>}
            </div>
          </section>
        )}

        {locked && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground rounded-md bg-muted/40 border border-border px-2 py-1.5">
            <Lock className="size-3 shrink-0" /> Agent is running — the plan is read-only until it finishes.
          </div>
        )}

        <section className="space-y-2">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[12px] font-medium text-ink-3 flex items-center gap-1.5"><Target className="size-3.5 text-brand-accent" /> Goal</h3>
            {!editingGoal && !locked && (
              <button onClick={startEditGoal} className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground" title="Edit goal"><Pencil className="size-3" /></button>
            )}
          </div>
          {editingGoal ? (
            <div className="space-y-1.5">
              <textarea
                value={goalDraft} onChange={e => setGoalDraft(e.target.value)} autoFocus rows={3}
                placeholder="What should Digby accomplish in this session?"
                className="w-full rounded-lg border border-border bg-transparent px-2.5 py-2 text-xs outline-none resize-none focus:border-brand-ring"
              />
              <div className="flex gap-2">
                <button onClick={saveGoal} className="text-xs bg-brand text-brand-foreground rounded-md px-2.5 py-1 flex items-center gap-1"><Check className="size-3" /> Save</button>
                <button onClick={() => setEditingGoal(false)} className="text-xs rounded-md px-2.5 py-1 hover:bg-muted text-muted-foreground">Cancel</button>
              </div>
            </div>
          ) : plan?.goal ? (
            <p className="text-xs leading-relaxed rounded-lg border border-brand-pale/40 bg-brand-soft/40 dark:bg-brand-dim/10 px-2.5 py-2">{plan.goal}</p>
          ) : (
            <button onClick={locked ? undefined : startEditGoal} disabled={locked}
              className="w-full text-left text-xs text-muted-foreground rounded-lg border border-dashed border-border px-2.5 py-2 hover:bg-muted/40 disabled:opacity-60">
              No goal set. {locked ? '' : 'Click to set one, or let Digby plan it.'}
            </button>
          )}
          {plan?.acceptanceCriteria?.length ? (
            <ul className="space-y-1 mt-1">
              {plan.acceptanceCriteria.map((c, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Check className="size-3 mt-0.5 shrink-0 text-success-accent/70" /><span>{c}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section className="space-y-2">
          <div className="flex items-center gap-1.5">
            <h3 className="text-[12px] font-medium text-ink-3 flex items-center gap-1.5"><ListChecks className="size-3.5 text-brand-accent" /> Todos</h3>
            {steps.length > 0 && <span className="ml-auto text-[10px] text-muted-foreground">{done}/{steps.length} done</span>}
          </div>
          {steps.length > 0 && (
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div className="h-full bg-success-accent transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
          <ul className="space-y-0.5">
            {steps.map((s) => {
              const Icon = TODO_ICON[s.status];
              return (
                <li key={s.id} className="group flex items-start gap-1.5 rounded-md px-1.5 py-1 hover:bg-muted/50">
                  <button
                    onClick={() => !locked && onCycleTodo(s)} disabled={locked}
                    className="mt-0.5 shrink-0 disabled:cursor-default" title={locked ? s.status : `Mark ${NEXT_STATUS[s.status].replace('_', ' ')}`}>
                    <Icon className={cn('size-3.5', TODO_ICON_COLOR[s.status])} />
                  </button>
                  <span className={cn('flex-1 text-xs leading-snug', s.status === 'completed' && 'line-through text-muted-foreground line-clamp-2')} title={s.status === 'completed' ? `${s.text}${s.note ? ` — ${s.note}` : ''}` : undefined}>
                    {s.text}{s.note ? <span className="text-muted-foreground"> — {s.note}</span> : null}
                  </span>
                  {!locked && (
                    <button onClick={() => onDeleteTodo(s)} className="opacity-100 md:opacity-0 md:group-hover:opacity-100 text-muted-foreground hover:text-destructive shrink-0" title="Delete todo">
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </li>
              );
            })}
            {steps.length === 0 && (
              <li className="text-xs text-muted-foreground px-1.5 py-1">No todos yet. Add one below, or ask Digby to plan the work.</li>
            )}
          </ul>
          {!locked && (
            <div className="flex items-center gap-1.5 rounded-lg border border-border px-2 py-1.5">
              <Plus className="size-3.5 text-muted-foreground shrink-0" />
              <input
                value={newTodo} onChange={e => setNewTodo(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submitTodo(); } }}
                placeholder="Add a todo…"
                className="flex-1 bg-transparent outline-none text-xs" />
              {newTodo.trim() && (
                <button onClick={submitTodo} className="text-xs text-brand-text font-medium shrink-0">Add</button>
              )}
            </div>
          )}
        </section>

        {showSchedulesLink && <ScheduleCountLine chatId={session.id} />}

        <section className="space-y-2">
          <h3 className="text-[12px] font-medium text-ink-3 flex items-center gap-1.5"><Eye className="size-3.5 text-brand-accent" /> Preview</h3>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground">localhost:</span>
            <input
              value={previewPort} onChange={e => setPreviewPort(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric" placeholder="3000"
              className="w-16 rounded border border-border bg-transparent px-1.5 py-0.5 text-xs outline-none focus:border-brand-ring" />
            <button
              onClick={() => { setLoadedPort(Number(previewPort)); setPreviewOn(true); setPreviewNonce(n => n + 1); }}
              disabled={!previewPort}
              className="text-xs bg-brand text-brand-foreground rounded-md px-2 py-0.5 disabled:opacity-40">
              {previewOn ? 'Reload' : 'Load'}
            </button>
            {previewOn && loadedPort != null && (
              <>
                <button onClick={() => setPreviewNonce(n => n + 1)} title="Reload preview" className="p-1 rounded hover:bg-muted text-muted-foreground"><RefreshCw className="size-3" /></button>
                <a href={codingApi.previewUrl(session.id, loadedPort, previewNonce)} target="_blank" rel="noreferrer" title="Open in a new tab" className="p-1 rounded hover:bg-muted text-muted-foreground"><ExternalLink className="size-3" /></a>
                <button onClick={() => setPreviewOn(false)} title="Close preview" className="p-1 rounded hover:bg-muted text-muted-foreground"><X className="size-3" /></button>
              </>
            )}
          </div>
          {/* src derives from the SNAPSHOTTED port — binding it to the live
              input navigated the iframe (white flash) on every keystroke. */}
          {previewOn && loadedPort != null && (
            <iframe
              key={previewNonce}
              src={codingApi.previewUrl(session.id, loadedPort, previewNonce)}
              className="w-full rounded-lg border border-border bg-white"
              style={{ height: '55vh' }}
              sandbox={PREVIEW_CROSS_ORIGIN
                ? 'allow-scripts allow-forms allow-popups allow-same-origin'
                : 'allow-scripts allow-forms allow-popups'}
              title="App preview" />
          )}
          {previewOn && (
            <p className="text-[10px] text-muted-foreground/70 leading-snug">Best-effort: SSR / plain-HTML apps render well; some SPA dev servers may not fully load — open in a new tab for the real thing.</p>
          )}
        </section>
      </div>
    </div>
  );
}

// ── The session view ──────────────────────────────────────────────────────────

// Attachment router constants (module scope: never change, keeps useCallback deps honest).
// Text/code files are inlined into the draft; everything else is rejected with a toast.
const CODE_ATTACH_TEXT_EXTS = new Set(['txt','md','markdown','json','csv','xml','yaml','yml','log','out','ts','tsx','js','jsx','mjs','cjs','py','java','go','rs','c','h','cpp','hpp','cs','rb','php','swift','kt','sh','bash','zsh','sql','html','htm','css','scss','less','toml','ini','cfg','conf','env','vue','svelte','diff','patch']);
const CODE_ATTACH_MAX_INLINE_BYTES = 200 * 1024; // 200 KB per text file
// 7b5ee09b: DOCUMENT files (pdf/docx/xlsx/xls) stage via POST /crossmodel/upload
// (the shared uploadChatFiles flow) and ride the run/steer body as uploadIds —
// the backend coding channel (7f546b03) resolves them into real worktree files.
// The MIME/extension sets mirror the backend upload.controller document subset.
const CODE_ATTACH_DOC_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // XLSX
  'application/vnd.ms-excel',                                                 // XLS (legacy)
]);
const CODE_ATTACH_DOC_EXTS = new Set(['pdf', 'docx', 'xlsx', 'xls', 'wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm']);

/** One-Session Platform P2 (chat 2922e8f6): plain-chat mode — when set, the view
    renders a NON-coding chat (no ChatCodingState satellite): transcript loads via
    crossModelApi.getChat, sends ride the legacy chat SSE (normalized into the
    coding event vocabulary by plain-session.ts), and coding-only chrome
    (branch/publish, vision paperclip, Overview section) is hidden. The
    workspace panel mounts IN-VIEW for plain too (C3 blocker 2) with the
    page-owned sections passed via panelSections. */
export interface PlainSessionProps {
  /** Pipeline mode (fast/thinking/auto/…) from the page's patience state. */
  mode: string;
  /** Patience plan 1a label window (2026-09-26): how the page's `mode` was
      chosen — 'picked' | 'default' | 'restored' (lib/depth-ux.ts PlainModeSource). Forwarded
      verbatim on every plain send (both the live send and the busy-queue
      passthrough); undefined (Auto, kids) sends nothing. */
  modeSource?: PlainModeSource;
  webSearch: boolean;
  /** The page knows a run is already live for this chat at mount — attach immediately. */
  attachOnLoad?: boolean;
  /** Plain ask_user answers go through the page's endpoint, not codingApi. */
  onAnswerQuestion?: (questionId: string, answer: string) => void;
  /** Canvas events are a page-level feature (canvas panel) — forwarded. */
  onCanvas?: (data: any) => void;
  /** Digby Frontier: the chat's canvases (page-owned) — each renders as an
   *  inline card under the answer that produced it (lib/canvas-attach.ts). */
  canvases?: CanvasItem[];
  /** Open one canvas in the side panel (the inline card's click). */
  onOpenCanvas?: (id: string) => void;
  /**
   * iMessage confirm-before-send card (page-level dialog) — forwarded. The
   * plain bridge dropped 'imessage-draft' since the 2026-07-23 cutover, so the
   * page's dialog never opened; E5 (2026-09-25) re-wires it and the payload
   * now carries `decisionId` for the send-intent gate's outcome label.
   */
  onImessageDraft?: (data: any) => void;
  /** Admin gate for the More-info panel (per-model responses are admin-only). */
  isAdmin?: boolean;
  /** Self-host setup hardening (2026-10-20): false on an instance with no search backend —
      the transparency pill then says the search was not possible instead of "searched the web". */
  webSearchConfigured?: boolean;
  /** Shared-project author attribution (58ffcf86 → C2 port, ticket 71b1fec6):
      the signed-in viewer's user id — a stored user row stamped with a
      DIFFERENT metadata.authorId renders as a teammate message (tinted bubble
      + "From: <name>" footnote). Undefined → every row renders as the
      viewer's own, exactly as before. */
  viewerId?: string | null;
  /** Plain attachments (P2 increment 2): the upload endpoint + bar state live in
      the PAGE (legacy machinery) — the view renders the page's bar into the
      composer's topContent slot, routes paperclip/drop/paste gestures to
      onAttachFiles, and at send time snapshots+clears the bar via
      takeAttachments (the legacy send() semantics). hasAttachments keeps the
      send button enabled for an attachment-only message. */
  hasAttachments?: boolean;
  takeAttachments?: () => PlainAttachmentRef[];
  attachmentsBar?: React.ReactNode;
  onAttachFiles?: (files: File[]) => void;
  /** bg-ES handoff: the view opened its own SSE for this chat — the page must
      close any page-level EventSource it still holds for it (agent attach pipe
      or a backgrounded foreground stream), so exactly one consumer remains. */
  onStreamClaim?: (chatId: string) => void;
  /** C3 (ticket 71b1fec6): ANONYMOUS GUEST mode — the owner's limited-guest
      directive ("very limited features and push cta to sign up for that
      access"). Guests always mount chatId-less (chatId null): no transcript
      GET, no attach, no panel sections, no attachments, patience levels 1–3
      (default Ensemble — owner 2026-09-23), and canvas
      events are folded into the answer as text (content preservation) instead
      of opening a panel. Sign-up CTAs live in the guest sidebar card (the
      top-of-transcript GuestBanner was removed — owner 2026-09-23) and in the
      answer itself when a request needs an account. The signed-in
      createChat-failure FALLBACK shares the chatId-less transport but keeps guest:false (full features, no CTAs). */
  guest?: boolean;
  /** Guest sessions (ticket 63bb607f): the guest's NAMED server-side context
      key (a client-minted UUID). Threaded into the chatId-less stream URL so
      every turn of this conversation rides the same 24h Redis cm_session:<id>
      context — reopening a stored guest session keeps its server-side memory.
      Guest-only; undefined for authed/fallback mounts. */
  guestSessionId?: string;
  /** Guest location getter ("City, Country" from browser geolocation, or
      undefined when denied/unknown — the server then falls back to an
      approximate IP lookup). Read at send time so a permission granted
      mid-conversation applies to the next turn. Guest-only. */
  guestLocation?: () => string | undefined;
  /** Ghost mode (2026-10-22): the OPEN conversation's flag. Guests: the
      page-owned mirror of the browser-local per-session store (plain-state,
      so a flip mid-conversation reaches the NEXT send without remounting),
      threaded as ghost=true on EVERY chatId-less send of the session (the
      signed-in createChat-failure fallback carries the home toggle's ARMED
      posture the same way). Signed-in, own plain chats: the chat row's
      ghostMode — the composer toggle's pressed state. It also rides that
      chat's send, where the server IGNORES it: a chat with a row runs on the
      row's STORED flag (chat-agent ghostRun), never a per-send opt-in. */
  ghost?: boolean;
  /** Flip the OPEN conversation's ghost posture — the ONE composer toggle.
      Guests: persists the browser-local per-session flag. Signed-in, own
      plain chats: writes the chat row (PUT /chats/:id; the page patches the
      sidebar row so the header badge and the side-panel switch flip with
      it). Undefined hides the composer toggle (kids, coding sessions,
      supervisor lanes, other people's chats, a posture not yet known, and —
      signed-in only — NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED=1). */
  onToggleGhost?: () => void;
  /** A signed-in flip is in flight — the toggle dims (never disabled: a
      disabled button swallows its tooltip) and the page ignores a second
      click. */
  ghostSaving?: boolean;
  /** Guest sessions (ticket 63bb607f): a REOPENED conversation's browser-local
      transcript — the chatless load branch seeds messages from it instead of
      starting empty. Undefined for a fresh guest chat (starts empty, as
      before). */
  initialTranscript?: CodingMessage[];
  /** Guest sessions (ticket 63bb607f): fired with the updated transcript after
      the user echo and after each complete-append, so the page can mirror it
      into the browser-local guest-session store. Provided for guest mounts;
      read via the messages ref at event time (never a stale closure). */
  onTranscriptChange?: (messages: CodingMessage[]) => void;
  /** C3 blocker 2 (ticket 71b1fec6, design D1): the page-owned Workspace panel
      sections for this plain chat — built by the PAGE through the
      workspace-sections registry (kind:'plain', isKid) because the nodes
      (CanvasPanel/ChatFilesSection/SchedulesSection) close over page state. The view
      mounts them in its in-flow panel (the ONE panel implementation); the
      page-level panel mounts now render only when no unified view is active.
      The open state is NOT here — it is the top-level controlled panelOpen
      prop, shared with coding sessions. */
  panelSections?: WorkspaceSection[];
  /** Depth UX (2026-09-26): the daily deep-research quota — shown on the
      research-rung "Dig deeper" chip (the badge re-keyed from the retired
      Level-3 picker state) and blocks the tap when exhausted. */
  deepResearchQuota?: DepthQuotaView | null;
  /** Depth UX: false hides the Dig-deeper chip entirely (kids; a page-level
      switch). Default true — the server's DIG_DEEPER_DISABLED still governs
      what a tap does. */
  digDeeperEnabled?: boolean;
  /** Guest sessions (2026-09-26): the SERVER-generated title for a chatId-less
      run — fired from the 'chat-title' frame and the `autoTitle` echo on
      complete so the page can retitle the browser-local record (the rail used
      to keep the raw first message forever). Guest-only. */
  onGuestTitle?: (guestSessionId: string, title: string) => void;
  /** Depth UX (audit 2026-09-26): a Dig-deeper tap / council send settled (complete, error or refusal) — the page re-reads the daily deep-research quota so the research chip greys in-session. */
  onDepthRunSettled?: () => void;
}

/** The supervisor dashboard section (if any) leads the side panel. */
function withLeadSection(lead: WorkspaceSection | null, rest: WorkspaceSection[]): WorkspaceSection[] {
  return lead ? [lead, ...rest.filter(s => s.id !== lead.id)] : rest;
}

export default function CodeSessionView({ header, chatId, onRunningChange, onTitleChange, initialMessage, initialImages, initialDisplayContent, onInitialMessageConsumed, onChromeChange, panelOpen: panelOpenProp, onPanelOpenChange, plain, isKid, settingsSection, pendingChatConfirmations, onResolvePendingConfirmation, pendingOwnerQuestions, onAnswerOwnerQuestion, onDismissOwnerQuestion, onOpenInbox, onOpenChat, viewerId }: {
  /** Owning chat. NULL only in C3 chatId-less plain mode (guest sessions + the
      signed-in createChat-failure fallback): the view then skips the transcript
      GET/attach/liveness probes and sends ride the open /crossmodel/stream
      endpoint (server-side cm_session context). Coding sessions always pass a
      real id. */
  chatId: string | null;
  /** Kids-mode account (COPPA) — gates the sponsored ThinkingAd slot. Kids are
      signed IN (user.isChild), so "coding needs auth" is NOT a sufficient guard. */
  isKid?: boolean;
  /** Lets the host page keep its sidebar "generating" dot honest. */
  onRunningChange?: (chatId: string, running: boolean) => void;
  /** Up-front LLM title (streamed at run start) — lets the host rename the sidebar row live. */
  onTitleChange?: (chatId: string, title: string) => void;
  /** Coding patience level: composer message that created this session — auto-sent once the worktree is ready.
      C3 blocker 1 (plain hand-off): may be '' for an attachment-only home-screen send — the staged
      files ride plain.takeAttachments and send() builds the server placeholder, so '' still fires. */
  initialMessage?: string;
  /** Images attached to the composer message that created this session (auto-sent with it). */
  initialImages?: ChatImage[];
  /** C3 blocker 1: clean bubble text for the initial PLAIN send (news follow-ups pass a long
      prompt but display a short label — legacy displayContent semantics). Echo-only; the server
      receives initialMessage, and a reload shows the stored content (same as the legacy view). */
  initialDisplayContent?: string;
  /** Called the moment the initial message is consumed so the host clears its copy (never re-fires).
      NULL chatId for C3 chatId-less mounts (guest/fallback) — the host clears its copy regardless. */
  onInitialMessageConsumed?: (chatId: string | null) => void;
  /** Pushes the session chrome (branch/status/publish/panel actions) up to the
      host's floating ⋯ menu — the session no longer renders its own header bar. */
  onChromeChange?: (chrome: CodingChrome | null) => void;
  /** Right-panel open state — CONTROLLED by the host page: ONE state drives the
      panel for every session kind (plain, coding, chatless), so the ⋯-menu
      toggle, the in-panel X, and the mobile backdrop never fork. When omitted
      the view falls back to its own internal state (uncontrolled mounts). */
  panelOpen?: boolean;
  onPanelOpenChange?: (open: boolean) => void;
  /** Inline confirm cards (ticket cbdb4614): the OPEN chat's live staged
      consequential-tool confirmations (already chat-scoped + liveness-filtered
      by the host page from its 20s /confirmations/pending poll). Rendered
      in-flow at the bottom of the transcript so the card is visible where the
      user is looking — staged confirmations previously surfaced ONLY in the
      collapsed sidebar rail / Management inbox, and mobile users never saw a
      card at all. */
  pendingChatConfirmations?: PendingConfirmation[];
  /** Confirm/cancel handler for a staged confirmation — the host page owns the
      API call + toast + poll refresh (same handler as the sidebar rail card). */
  onResolvePendingConfirmation?: (p: PendingConfirmation, action: 'confirm' | 'cancel') => void;
  /** Owner 2026-09-22: the open chat's flagged owner questions, rendered in-flow
      as answerable cards (options as buttons) — the rail link used to land here
      with nothing to act on. */
  pendingOwnerQuestions?: PendingConfirmation[];
  onAnswerOwnerQuestion?: (p: PendingConfirmation, answer: string) => void | Promise<void>;
  onDismissOwnerQuestion?: (p: PendingConfirmation) => void | Promise<void>;
  onOpenInbox?: () => void;
  /** Inline task card (cohesive chat, 2026-09-28): open the sub-session a
      card names (kind 'session' → childChatId). The host page owns navigation. */
  onOpenChat?: (chatId: string) => void;
  plain?: PlainSessionProps;
  /** Ticket 7acaa7ba: the signed-in viewer's user id. When set and DIFFERENT
      from the coding session's owner (activeSession.userId), the composer
      renders read-only — members can watch runs and read the transcript but
      only the owner can start/steer runs (server-enforced; this is honest UX,
      not the gate). */
  viewerId?: string | null;
  /** The panel's Settings tab node (owner directive 2026-09-09) — page-built
      (it closes over page state: patience, autonomy, the pushed-up workspace
      chrome) and mounted LAST by this view for BOTH session kinds, matching
      the registry's order (…, browser, settings). Omitted → no Settings tab. */
  settingsSection?: WorkspaceSection | null;
  /** The host's in-flow chat header (Digby Frontier 2026-10-06 —
      FloatingChrome): mounted at the top of the CHAT column, above the
      transcript, so an open side panel keeps its own header. */
  header?: ReactNode;
}) {
  // Shared branding core (todo d2d32b57) — Digby unless the operator rebranded.
  const branding = useBranding();
  const [activeSession, setActiveSession] = useState<(CodingSession & { project?: CodingProject }) | null>(null);
  const [project, setProject] = useState<CodingProject | null>(null);
  const [messages, setMessages] = useState<CodingMessage[]>([]);
  // Ref mirror of `messages` for async merge points (a paged refetch unions
  // into the loaded history — reading state directly would race the reset).
  const messagesRef = useRef<CodingMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const [live, setLive] = useState<LiveRun>({ parts: [], pendingApproval: null, running: false });
  // Browser program (UI Phase 6a): the chat-scoped agent-browse activity log,
  // fed by `browser_observation` events (coding stream natively; plain chats
  // via makeLegacyNormalizer's 'browser-observation' mapping). SEPARATE from
  // live.parts on purpose — the panel stays reviewable after the run ends.
  // Reset on chat switch, on a run-switch replay, and before any FULL replay
  // (which rebuilds it from the replayed events — see connectStream).
  const [browserActivity, setBrowserActivity] = useState<BrowserActivityState>(EMPTY_BROWSER_ACTIVITY);
  const [browserSheet, setBrowserSheet] = useState<BrowserSheetState>(CLOSED_BROWSER_SHEET);
  // First-observation edge (tab auto-focus) without a setState side effect.
  const hadBrowserActivityRef = useRef(false);
  const resetBrowserActivity = useCallback(() => {
    hadBrowserActivityRef.current = false;
    setBrowserActivity(EMPTY_BROWSER_ACTIVITY);
    setBrowserSheet(CLOSED_BROWSER_SHEET);
  }, []);
  // Persisted-screenshot seed (2026-09-23): a reloaded chat has no live frames,
  // but the run's final screenshot lives in the transcript as an assistant
  // `image` part — show it in the Browser tab so the tab is never a blank
  // surprise after a refresh. Live frames always win (only seeds when empty).
  useEffect(() => {
    if (browserActivity.entries.length || live.running) return;
    const seeded = seedBrowserActivityFromMessages(messages);
    if (seeded) setBrowserActivity(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, live.running]);
  const [runStart, setRunStart] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState(MSG_WINDOW);
  // Plain-mode server paging (review H2): the transcript loads the NEWEST page
  // (messageLimit 50) — older pages fetch on demand via the cursor and PREPEND.
  // The local MSG_WINDOW windowing still layers on top (expand it first, then
  // fetch). Coding sessions got the same server paging 2026-08-31 (codingPaging
  // below) — before that they loaded their full transcript on every open.
  const [plainPaging, setPlainPaging] = useState<{ hasMore: boolean; cursor: string | null }>({ hasMore: false, cursor: null });
  const [codingPaging, setCodingPaging] = useState<{ hasMore: boolean; cursor: string | null }>({ hasMore: false, cursor: null });
  // Plain-mode initial-load settle flag (C3 blocker 1): the plain auto-start
  // must wait for the first transcript GET — firing during it would let the
  // GET's setMessages clobber the send echo (and its setLive reset the run
  // state). Plain chats have no coding satellite, so this replaces the
  // `activeSession.status === 'ready'` gate for them.
  const [plainLoaded, setPlainLoaded] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Scroll-position snapshot armed just before a prepend commits; a layout
  // effect restores by the scrollHeight delta so the viewport doesn't jump.
  const prependScrollRef = useRef<{ height: number; top: number } | null>(null);
  // Plain mode renders the user's chat text-size preference (review: the code
  // transcript's dense scale is NOT the classic chat scale); coding keeps the
  // dense defaults (sizes stays undefined → CodeTranscriptMarkdown defaults).
  const { prefs } = usePreferences();
  // P4: the composer is the SHARED ChatComposer — its draft lives inside
  // ChatComposerTextarea (imperative handle); hasText mirrors empty↔non-empty
  // flips for the send/steer buttons (same pattern as the chat page).
  const composerRef = useRef<ChatComposerHandle>(null);
  // Voice input (0c256c3a): shared hook (same as plain chat) — send/steer paths
  // call voice.discardRecording() so a committed draft is never re-injected.
  const voice = useVoiceComposer({ composerRef });
  const [hasText, setHasText] = useState(false);
  // "How Digby answered" disclosure per assistant row (Digby Frontier).
  const [howOpen, setHowOpen] = useState<Record<string, boolean>>({});
  const [publishing, setPublishing] = useState<'push' | 'pr' | null>(null);
  const [plan, setPlan] = useState<CodingPlan | null>(null);
  const [internalPanelOpen, setInternalPanelOpen] = useState(false);
  // ONE panel open state: the host page owns it for every session kind via the
  // controlled props; the internal state only serves uncontrolled mounts.
  // `setPanel` is the single write path — every close/toggle routes through it.
  const panelOpen = panelOpenProp ?? internalPanelOpen;
  const setPanel = useCallback((open: boolean) => {
    if (onPanelOpenChange) onPanelOpenChange(open); else setInternalPanelOpen(open);
  }, [onPanelOpenChange]);

  // ── Files section (ticket 59a4454e) — the chat's canvases as a file browser in
  // the workspace panel, parity with the chat-surface Files panel. Coding sessions
  // only: plain chats render their files via the page-OWNED section nodes passed
  // in through plain.panelSections (C3 blocker 2).
  const [chatFiles, setChatFiles] = useState<CanvasItem[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  // Per-chat Files section (57ef1b9f PR2): bumped when a run completes so
  // ChatFilesSection refetches (uploads sent with a steer message, docs the
  // agent generated this turn).
  const [filesRefreshKey, setFilesRefreshKey] = useState(0);
  useEffect(() => {
    if (plain || !chatId) return;
    let cancelled = false;
    // Worktree previews (readOnly, worktree:<path> ids) are chat-scoped and
    // transient — drop them immediately on a chat switch so they never show
    // under another chat (the DB fetch below only replaces persisted rows).
    setChatFiles(prev => (prev.some(c => c.readOnly) ? prev.filter(c => !c.readOnly) : prev));
    setActiveFileId(cur => (cur && cur.startsWith(WORKTREE_CANVAS_PREFIX) ? null : cur));
    canvasApi.listForChat(chatId).then((cs: any[]) => {
      if (cancelled) return;
      setChatFiles(cs.map((c: any) => ({
        id: c.id,
        title: c.title,
        type: c.type as CanvasItem['type'],
        language: c.language ?? null,
        content: c.content || '',
        version: c.version,
        updatedAt: c.updatedAt,
      })));
    }).catch(() => { /* files are best-effort */ });
    return () => { cancelled = true; };
  }, [chatId, plain]);
  const updateChatFile = useCallback((id: string, content: string, title?: string) => {
    // Worktree previews are read-only and DB-less — local state only (the UI
    // hides every edit path; this is the belt-and-suspenders guard).
    if (id.startsWith(WORKTREE_CANVAS_PREFIX)) return;
    setChatFiles(prev => prev.map(c =>
      c.id === id ? { ...c, content, ...(title !== undefined && { title }), version: c.version + 1 } : c
    ));
    canvasApi.update(id, { content, ...(title !== undefined && { title }) }).catch(() => {});
  }, []);
  const deleteChatFile = useCallback((id: string) => {
    setChatFiles(prev => prev.filter(c => c.id !== id));
    setActiveFileId(cur => (cur === id ? null : cur));
    // Worktree previews have no DB row to delete.
    if (id.startsWith(WORKTREE_CANVAS_PREFIX)) return;
    canvasApi.delete(id).catch(() => {});
  }, []);
  const createChatFile = useCallback(async () => {
    if (!chatId) return; // C3 chatId-less mounts never offer file creation
    try {
      const c = await canvasApi.create(chatId, { title: 'Untitled', type: 'document', content: '' });
      const item: CanvasItem = {
        id: c.id,
        title: c.title,
        type: 'document',
        language: null,
        content: c.content || '',
        version: c.version,
        updatedAt: c.updatedAt,
      };
      setChatFiles(prev => [...prev, item]);
      setActiveFileId(item.id);
    } catch {
      toast.error('Could not create the file');
    }
  }, [chatId]);

  // ── Worktree inline viewer (ticket 999e3dbe, Phase 1) ─────────────────────
  // A file click in the WorktreeTree opens the file READ-ONLY in the canvas
  // panel above: the fetched content becomes a transient readOnly CanvasItem
  // (id + title = `worktree:<path>`, so the canvas header shows the
  // worktree-relative path). Phase 1 has no diff view / no edit-in-place.
  // Resolves true when a preview was opened (CodingFilesTabs hops back to the
  // "Files" sub-tab to show it); 413/415/400/404 open an inline NOTICE canvas
  // instead of failing — only a transient error toasts + returns false.
  const openWorktreeFile = useCallback(async (path: string): Promise<boolean> => {
    if (!chatId) return false;
    /** One readOnly preview at a time (each can hold 256 KB) — replace, never accumulate. */
    const openPreview = (content: string, language: string | null) => {
      const item: CanvasItem = {
        id: `${WORKTREE_CANVAS_PREFIX}${path}`,
        title: `${WORKTREE_CANVAS_PREFIX}${path}`,
        type: 'code',
        language,
        content,
        version: 1,
        readOnly: true,
      };
      setChatFiles(prev => [...prev.filter(c => !c.readOnly), item]);
      setActiveFileId(item.id);
    };
    try {
      const res = await getWorktreeFile(chatId, path);
      openPreview(res.content, worktreeLanguageForPath(res.path || path));
      return true;
    } catch (e: any) {
      const status = e?.response?.status as number | undefined;
      const serverMsg = typeof e?.response?.data?.error === 'string' ? e.response.data.error : '';
      if (status === 413 || status === 415 || status === 400 || status === 404) {
        // Honest inline notice in the canvas — never a crash, never a silent no-op.
        const heading =
          status === 413 ? 'File too large to preview'
            : status === 415 ? 'Binary file'
              : status === 404 ? 'File not found'
                : 'Cannot preview this file';
        openPreview(`${heading}\n\n${path}\n\n${serverMsg}`.trim(), null);
        return true;
      }
      toast.error('Could not load the file — try again.');
      return false;
    }
  }, [chatId]);
  // Ticket 19fbd876: REAL-BYTE download for a read-only worktree preview —
  // the canvas content is the fetched TEXT (for a binary file, the 415
  // notice), so blobbing it would hand the owner a mislabeled .txt. This
  // fetches /worktree/raw (disk → snapshot → live cross-box, binary fine,
  // 16 MB cap) and names the file from the worktree-relative path.
  const downloadWorktreeCanvas = useCallback(async (canvas: CanvasItem): Promise<void> => {
    if (!chatId) return;
    const wtPath = canvas.id.startsWith(WORKTREE_CANVAS_PREFIX) ? canvas.id.slice(WORKTREE_CANVAS_PREFIX.length) : canvas.title;
    await downloadWorktreeFile(chatId, wtPath);
  }, [chatId]);
  // P4: tri-state — 'no_workspace' keeps the honest satellite-less copy for a
  // coding GET 404; 'error' (network/5xx, and any plain-transcript failure)
  // renders a retryable LoadErrorState instead of the wrong workspace copy.
  // 'deleted' (owner 2026-10-27, "deleted chat still sits in the view"): the
  // chat row is GONE server-side — the cold-load 404 or a terminal probe
  // landed here. Every retry would 404 again, so this arm is terminal honest
  // copy, no retry affordance (the page also clears the open mount on
  // delete/archive/SSE-notice — this is the belt-and-braces view-side layer
  // for a view whose chat died while it was already mounted).
  const [loadFailed, setLoadFailed] = useState<false | 'no_workspace' | 'deleted' | 'error'>(false);
  // Supervisor lanes (fleet or per-project) are machine-authored surfaces:
  // their finals quote the harness clock ("WAKE — 03:43Z"), which the
  // transcript shows in the viewer's local time (owner 2026-09-14).
  const [supervisorChat, setSupervisorChat] = useState(false);
  // Supervisor dashboards (owner 2026-10-08, lib/supervisor-panel.ts): a project / fleet supervisor chat's side panel
  // leads with its project / fleet view. One light read (the row + its newest message) works for plain AND coding
  // chats; the panel switches to the new section once it exists.
  const [supervisorPanel, setSupervisorPanel] = useState<SupervisorPanelTarget | null>(null);
  useEffect(() => {
    setSupervisorPanel(null);
    if (!chatId || isKid) return;
    let alive = true;
    crossModelApi.getChat(chatId, { messageLimit: 1 })
      .then(full => { if (alive) setSupervisorPanel(supervisorPanelFor(full)); })
      .catch(() => { /* not readable / guest — no supervisor panel */ });
    return () => { alive = false; };
  }, [chatId, isKid]);
  useEffect(() => { if (supervisorPanel) openWorkspaceSection(supervisorPanel.kind); }, [supervisorPanel]);
  const supervisorSection = useMemo<WorkspaceSection | null>(() => {
    if (!supervisorPanel) return null;
    if (supervisorPanel.kind === 'fleet') return { id: 'fleet', label: 'Fleet', icon: <Network className="size-4" />, node: <FleetSupervisorPanel selfChatId={chatId} /> };
    return supervisorPanel.projectId
      ? { id: 'project', label: 'Project', icon: <LayoutDashboard className="size-4" />, node: <ProjectSupervisorPanel projectId={supervisorPanel.projectId} selfChatId={chatId} /> }
      : null;
  }, [supervisorPanel, chatId]);
  // Bumped by the error state's Retry — re-runs the whole load effect.
  const [loadNonce, setLoadNonce] = useState(0);
  const esRef = useRef<EventSource | null>(null);
  const activeIdRef = useRef<string | null>(null);
  // Guest resume (2026-09-26): the token of the resume loop this mount owns —
  // a remount / session switch / unmount clears it so a stale loop stops.
  const guestResumeRef = useRef<string | null>(null);
  useEffect(() => () => { guestResumeRef.current = null; }, []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const transcriptContentRef = useRef<HTMLDivElement | null>(null);

  // ── Inline task card (cohesive chat, 2026-09-28 — lib/task-card.ts) ────────
  // The card's actions: "Open result" scrolls to the assistant row the result
  // was posted as (every row carries data-msg-id), "Reply below" focuses the
  // composer, "Open session" hands the child chat to the host page.
  const taskActions = useMemo<TaskCardActions>(() => ({
    openResult: (messageId: string) => {
      const esc = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(messageId) : messageId.replace(/["\\]/g, '\\$&');
      const row = transcriptContentRef.current?.querySelector<HTMLElement>(`[data-msg-id="${esc}"]`);
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    focusComposer: () => composerRef.current?.focus(),
    ...(onOpenChat ? { openChat: onOpenChat } : {}),
  }), [onOpenChat]);
  // The sub-session Result section: the newest settled task the transcript
  // carries (a `task` part, or the hand-off's metadata.task). Coding sessions
  // only, never while a run is live.
  const sessionResult = useMemo(
    () => (!plain && !live.running ? findSessionResult(messages) : null),
    [plain, live.running, messages],
  );
  // A RESTORED card that is still running / waiting has no stream attached in
  // this tab (a reload, or the run continues in the background on this chat):
  // poll the chat's newest rows and fold every task part they carry into the
  // rendered rows (ONE card per task — applyTaskToMessages updates in place).
  // A 'session' task ALSO reads its child session's status — the existing
  // live-run status feed — mapped onto the SAME card (a child in 'error'
  // fails the card; the hand-off decides "done", never the poll). Bounded:
  // 10 s cadence, 30 min per card set; stops when nothing is pending, when a
  // stream attaches (live frames take over), or when the chat changes.
  const pendingTaskKey = useMemo(() => pendingTasksOf(messages).map(t => `${t.taskId}:${t.childChatId ?? ''}`).join('|'), [messages]);
  useEffect(() => {
    if (!plain || !chatId || live.running || !pendingTaskKey) return;
    const sid = chatId;
    let cancelled = false;
    const startedAt = Date.now();
    const tick = async () => {
      if (cancelled || activeIdRef.current !== sid) return;
      const pending = pendingTasksOf(messagesRef.current);
      if (!pending.length || Date.now() - startedAt > 30 * 60_000) return;
      try {
        const full = await crossModelApi.getChat(sid, { messageLimit: 20 });
        if (cancelled || activeIdRef.current !== sid) return;
        for (const row of mapPlainMessages(full)) for (const t of tasksOfMessage(row.parts)) setMessages(prev => applyTaskToMessages(prev, t));
      } catch { /* transient — the next tick re-probes */ }
      for (const t of pending) {
        if (t.kind !== 'session' || !t.childChatId) continue;
        try {
          const child = await codingApi.getSession(t.childChatId, { messageLimit: 1 });
          if (cancelled || activeIdRef.current !== sid) return;
          const merged = mergeChildSessionIntoTask(t, child);
          if (merged !== t) setMessages(prev => applyTaskToMessages(prev, merged));
          const handedBack = (child.messages || []).flatMap(m => tasksOfMessage(m.parts)).find(x => x.taskId === t.taskId);
          if (handedBack) setMessages(prev => applyTaskToMessages(prev, handedBack));
        } catch { /* a child that cannot be read leaves the card as the harness last reported it */ }
      }
    };
    const timer = setInterval(() => { void tick(); }, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [plain, chatId, live.running, pendingTaskKey]);
  const reconnectRef = useRef<{ timer: ReturnType<typeof setTimeout> | null; attempts: number }>({ timer: null, attempts: 0 });
  const lastResyncRef = useRef(0);
  const pinnedRef = useRef(true);
  // Attach-replay scroll gate: subscribing to a running session REPLAYS the
  // run's whole buffered event ring, and each replayed event grows live.parts —
  // firing the pinned autoscroll effect + RO stick once PER EVENT, so the view
  // visibly chases a moving bottom through messages the user already saw (and
  // again on every focus-resync/reconnect, which wipes parts and re-replays).
  // While a burst is in flight the per-event scrolls are suppressed; one
  // landing scroll runs ~150ms after the last replayed event.
  const replayActiveRef = useRef(false);
  const replayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pre-paint initial anchor: arming on chat change lets a layout effect scroll
  // to the latest message BEFORE the first painted frame — the passive-effect
  // scroll used to flash the top of a long transcript then visibly jump.
  const initialAnchorRef = useRef(false);
  const noteReplayActivity = useCallback(() => {
    replayActiveRef.current = true;
    if (replayTimerRef.current) clearTimeout(replayTimerRef.current);
    replayTimerRef.current = setTimeout(() => {
      replayTimerRef.current = null;
      replayActiveRef.current = false;
      followLatestRef.current();
    }, 150);
  }, []);
  // Turn anchor (owner 2026-10-07: "it pulls the user to the bottom and they
  // have to scroll all the way up to the beginning of the response"). While
  // pinned, the view follows new content only until the newest turn's start
  // reaches the top (lib/transcript-pin followTarget), so a reply is read from
  // its first line. capOffKeyRef = the anchor row the reader opted back into
  // full follow for (scrolled to the bottom by hand / Jump to latest / the
  // chat-open landing); capTopRef = the stop line last applied (null = none).
  const capOffKeyRef = useRef<string | null>(null);
  const capTopRef = useRef<number | null>(null);
  const followLatestRef = useRef<() => void>(() => {});
  /** When the reader last sent (ms) — a new chat's first send switches chats,
   *  and that landing must not release the anchor of the turn just sent. */
  const sentAtRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  /** lib/transcript-pin gesture window — see onTranscriptScroll. */
  const upGestureUntilRef = useRef(0);
  const [showJumpToEnd, setShowJumpToEnd] = useState(false);
  // Optimistic steer bubbles: ids of user messages echoed locally by steer(),
  // captioned "queued" until the run ends (the steer is persisted server-side
  // immediately — coding-stream.controller.ts — but folds in at the next step).
  const [pendingSteerIds, setPendingSteerIds] = useState<Set<string>>(new Set());
  // Ref mirror for the []-dep applyFetchedSession callback (it must read the
  // CURRENT pending set to reconcile echoes with their server twins).
  const pendingSteerIdsRef = useRef<Set<string>>(pendingSteerIds);
  pendingSteerIdsRef.current = pendingSteerIds;
  // Ticket 81b229e1: the EXACT `tmp-*` echo → server queue-row pairing, recorded
  // when the enqueue ack lands. reloadPlain uses it to drop the optimistic echo
  // in favour of the row it became, instead of guessing by text + clock (the
  // promote path re-stamps that row's createdAt, so a clock test is unreliable).
  const plainEchoToPendingRef = useRef<Map<string, string>>(new Map());
  const [steering, setSteering] = useState(false);
  // ── Queued-message controls (ticket ea04454c) ─────────────────────────────
  // The owner's ask: "we need to add interrupt/steer options in ui as well not
  // just queued messages." `queueItems` is the caller's own pending-message list
  // straight from the server (drain order), rendered with position +
  // cancel/promote/reorder. Interrupting is a separate small composer button
  // (ticket b54efe5d) — NOT a sticky mode, so there is no send-mode state here.
  const [queueItems, setQueueItems] = useState<QueuedItem[]>([]);
  const [queueBusy, setQueueBusy] = useState(false);
  const [questionDraft, setQuestionDraft] = useState('');
  // Multi-select ask_user cards: the options the user has toggled on (cleared per question).
  const [questionPicks, setQuestionPicks] = useState<Set<string>>(() => new Set());
  // Image attachments (vision-capable models only — backend enforces the caps).
  const [pendingImages, setPendingImages] = useState<Array<{ mediaType: string; data: string; name: string; previewUrl: string }>>([]);
  const [imageNote, setImageNote] = useState<string | null>(null);
  // 7b5ee09b: DOCUMENT attachments (pdf/docx/xlsx/xls) staged through the shared
  // upload flow — the chips are removable; their uploadIds ride the run/steer
  // body and the backend stages the real files into the session worktree.
  const [pendingUploads, setPendingUploads] = useState<AttachmentInfo[]>([]);
  // Send-while-provisioning queue (owner 2026-10-14, lib/provision-queue.ts):
  // a send on a session whose worktree is still provisioning is KEPT here —
  // echoed as a queued bubble under the transcript — and goes out the moment
  // the session reads 'ready'. The ref is the synchronous truth (the auto-start
  // effect and the drain effect can run in the same commit); localStorage
  // mirrors it per session so a reload while provisioning keeps the message.
  const [provisionQueue, setProvisionQueueState] = useState<ProvisionQueued[]>([]);
  const provisionQueueRef = useRef<ProvisionQueued[]>([]);
  const setProvisionQueue = useCallback((sid: string | null, items: ProvisionQueued[]) => {
    provisionQueueRef.current = items;
    setProvisionQueueState(items);
    if (sid) saveProvisionQueue(sid, items);
  }, []);
  // Guest send-while-running queue (d0777a67): a chatless GUEST mount has no
  // server busy-queue, so a mid-run send is held here (echoed as a queued
  // bubble) and drains as ONE merged send when the run ends. In-memory only —
  // the guest browser-local store keeps everything the server received.
  const [guestQueue, setGuestQueueState] = useState<GuestQueuedSend[]>([]);
  const guestQueueRef = useRef<GuestQueuedSend[]>([]);
  const setGuestQueue = useCallback((items: GuestQueuedSend[]) => {
    guestQueueRef.current = items;
    setGuestQueueState(items);
  }, []);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Gate violations toast PER GESTURE (2026-08-19) — the earlier one-shot-per-
  // mount guard made every second attempt a silent no-op, which read exactly
  // like the dead paperclip it was meant to fix.
  // Drag-over visual state for the composer (drop zone highlight).
  const [dragOver, setDragOver] = useState(false);
  const addImageFiles = useCallback((files: Iterable<File>) => {
    const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    for (const f of files) {
      if (!ALLOWED.has(f.type)) { setImageNote('Only PNG, JPEG, WebP, or GIF images.'); continue; }
      if (f.size > 5 * 1024 * 1024) { setImageNote(`"${f.name}" is over the 5 MB per-image limit.`); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result || '');
        const data = url.includes(',') ? url.slice(url.indexOf(',') + 1) : url;
        setPendingImages(prev => {
          if (prev.length >= 4) { setImageNote('At most 4 images per message.'); return prev; }
          setImageNote(null);
          return [...prev, { mediaType: f.type, data, name: f.name, previewUrl: url }];
        });
      };
      reader.readAsDataURL(f);
    }
  }, []);
  // File router for the paperclip picker AND drag-and-drop (2026-08-14: drops
  // used to hit a composer with no drag handlers at all — a dead interaction,
  // and the paperclip only accepted images so non-vision sessions felt broken).
  // Images ride the base64 vision path above; text/code files are read in the
  // browser and inlined into the draft as fenced blocks (agent-side compaction
  // clips oversized messages, hence the 200 KB cap); DOCUMENT files
  // (pdf/docx/xlsx/xls — 7b5ee09b) stage through the SHARED chat upload channel
  // (uploadChatFiles → POST /crossmodel/upload) and their uploadIds ride the
  // run/steer body — the backend resolves them into real files staged into the
  // session worktree (7f546b03), text extract included. Never a silent no-op:
  // every rejection toasts — PER GESTURE (2026-08-19: the earlier one-shot-per-
  // mount guard made every SECOND image pick on a non-vision model silent,
  // which read exactly like the dead paperclip it was meant to fix).
  const handleIncomingFiles = useCallback((incoming: Iterable<File>) => {
    const images: File[] = [];
    const docs: File[] = [];
    const rejected: string[] = [];
    for (const f of incoming) {
      if (f.type.startsWith('image/')) { images.push(f); continue; }
      const ext = (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
      if (CODE_ATTACH_DOC_MIMES.has(f.type) || CODE_ATTACH_DOC_EXTS.has(ext)) { docs.push(f); continue; }
      const isText = f.type.startsWith('text/') || f.type === 'application/json' || f.type.endsWith('+json')
        || f.type === 'application/xml' || f.type.endsWith('+xml') || CODE_ATTACH_TEXT_EXTS.has(ext);
      if (!isText) { rejected.push(f.name); continue; }
      if (f.size > CODE_ATTACH_MAX_INLINE_BYTES) {
        toast.error(`"${f.name}" is over 200 KB — too large to attach inline.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        const cur = composerRef.current?.getValue() ?? '';
        const block = `${cur.trim() ? '\n\n' : ''}--- ${f.name} ---\n\`\`\`\n${text}\n\`\`\`\n`;
        composerRef.current?.setValue(cur + block);
        composerRef.current?.focus();
      };
      reader.onerror = () => toast.error(`Couldn't read "${f.name}" — try again.`);
      reader.readAsText(f);
    }
    if (docs.length) {
      // Stage through the shared upload flow (attachments.tsx) — per-file
      // staging failures toast inside uploadChatFiles (loud, never silent) and
      // only the successes land as chips.
      void uploadChatFiles(docs).then(newItems => {
        if (newItems.length) setPendingUploads(prev => [...prev, ...newItems]);
      });
    }
    if (images.length) {
      // NEVER refuse: text-only models get describe-and-inject server-side
      // (coding-stream.controller startRun/steer — the attachment works, the
      // model is handed a vision-agent description). The old refusal here read
      // exactly like the dead paperclip (owner report 2026-09-13: "now i cant
      // even send images to you either"). Attach, then say honestly when the
      // model itself won't see pixels.
      addImageFiles(images);
      const sessionModel = activeSession?.model;
      if (!sessionModel || !modelSupportsVision(sessionModel)) {
        toast.info('Attached — Digby will describe the image for this text-only model', { description: 'For native vision, switch the coding model to Digby or DeepSeek V4.1 Flash (Account → Coding).' });
      }
    }
    if (rejected.length) {
      const names = rejected.slice(0, 3).join(', ') + (rejected.length > 3 ? ` +${rejected.length - 3} more` : '');
      toast.info(`Can't attach ${names} — images, audio, text/code files, and PDF/DOCX/XLSX documents work in a coding session.`);
    }
  }, [activeSession?.model, addImageFiles]);
  // Resizable workspace panel (md+ only; drawer keeps its width on
  // mobile) — the SHARED rail controller (lib/use-resizable.ts, owner UI pass
  // 2026-09-07): drag clamps 280–720, double-click resets to 320, width
  // persists per surface ('digby.panel.w'; pre-pass widths migrate from the
  // legacy key). Handle sits on the panel's LEFT edge — dragging left widens.
  const panelRail = useResizable({
    storageKey: 'digby.panel.w', defaultWidth: 320, minWidth: 280, maxWidth: 720,
    edge: 'left', legacyKeys: ['digby-code-panel-w'],
  });
  // The panel renders only when a coding session OR a plain session with
  // sections mounts it (the same gate as the <aside> below).
  const panelRendered = !plain || (plain.panelSections?.length ?? 0) > 0 || !!settingsSection;
  // P2 item 6 (pill/tab-strip geometry): hoist the OPEN panel's width to the
  // root as --panel-open-w so the fixed FloatingChrome pills (page-level —
  // they can't see the panel column) can offset themselves left of the panel
  // edge on md+ instead of overlapping its tab strip. 0px whenever the panel
  // is closed or unmounted; below md the panel is a z-overlay drawer that
  // simply covers the z-raised pills, and the pills' md: variant ignores the
  // var there. Same documentElement-var idiom as lib/use-app-viewport.ts.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--panel-open-w', panelRendered && panelOpen ? `${panelRail.width}px` : '0px');
    return () => { root.style.removeProperty('--panel-open-w'); };
  }, [panelRendered, panelOpen, panelRail.width]);
  // Token/cost meter: the SERVER computes durable whole-session totals (all
  // runs + every subagent, reload-proof) and sends them on every 'context'
  // event and in GET /sessions/:id — the client just displays the latest.
  // lastAdded is a display nicety: run-total delta between consecutive events.
  const [sessionUsage, setSessionUsage] = useState<SessionUsage | null>(null);
  const [lastAddedTokens, setLastAddedTokens] = useState(0);
  const lastRunTotalRef = useRef<{ runId?: string; total: number }>({ total: 0 });
  // Self-configuring preview: a dev server the agent started (with ready.port)
  // fires preview_ready — the Overview pane configures + loads itself.
  const [previewHint, setPreviewHint] = useState<{ port: number; ts: number } | null>(null);
  const [previewDefaultPort, setPreviewDefaultPort] = useState<number | null>(null);
  const appliedPreviewPortRef = useRef<number | null>(null); // last port auto-applied — dedupes replayed preview_ready
  // 05303f58 (BUG 2): signatures of terminal 'error' frames already toasted —
  // a stream replay on reconnect re-delivers the same error event; toast it
  // once per mount, not N times (the "cloning failed" toast storm).
  const toastedErrorSigsRef = useRef<Set<string>>(new Set());
  // Host callbacks live in refs: the host page passes inline arrows (new
  // identity every render), and threading them through useCallback deps made
  // connectStream — and therefore the session-LOAD effect — re-fire on every
  // host re-render: the whole view blanked to a spinner and remounted at every
  // run start/stop (the owner's "flickers every time I send", 2026-07-18).
  const onTitleChangeRef = useRef(onTitleChange);
  const onRunningChangeRef = useRef(onRunningChange);
  const onChromeChangeRef = useRef(onChromeChange);
  useEffect(() => { onTitleChangeRef.current = onTitleChange; onRunningChangeRef.current = onRunningChange; onChromeChangeRef.current = onChromeChange; });
  // Live handle on the session for the floating-chrome actions — lets push/PR/
  // permission-mode callbacks keep a STABLE identity (empty deps) while acting
  // on the current session, so the host menu never re-renders in a loop.
  const activeSessionRef = useRef(activeSession);
  useEffect(() => { activeSessionRef.current = activeSession; });
  // Stable identity for every live part — keys must survive the
  // MAX_LIVE_PARTS front-slice and the tool_call→result pairing.
  const partSeqRef = useRef(0);
  // Status-line throttle: per-token thinking summaries swap the text dozens of
  // times a second otherwise.
  const statusAtRef = useRef(0);
  // Trailing-edge slot for the status throttle below (owner 2026-09-15): the
  // LAST message of a burst must land, never be dropped.
  const statusTrailRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Throwaway busy-queue EventSource (queuePlainBehindLive) — tracked so the
  // unmount teardown closes it too (review M2: it outlived chat switches).
  const plainQueueEsRef = useRef<EventSource | null>(null);

  // Tear down the stream on unmount / chat switch.
  useEffect(() => () => {
    esRef.current?.close();
    plainQueueEsRef.current?.close(); plainQueueEsRef.current = null;
    if (reconnectRef.current.timer) clearTimeout(reconnectRef.current.timer);
    if (replayTimerRef.current) clearTimeout(replayTimerRef.current);
  }, [chatId]);

  // The usage meter is per-session: switching sessions must not carry the old
  // session's totals into the new one (the load effect re-seeds from the server).
  useEffect(() => {
    setSessionUsage(null);
    setLastAddedTokens(0);
    lastRunTotalRef.current = { total: 0 };
    setPreviewHint(null);
    setPreviewDefaultPort(null);
    appliedPreviewPortRef.current = null;
  }, [chatId]);

  const setRunning = useCallback((sid: string | null, running: boolean) => {
    // C3: chatId-less guests/fallbacks have no sidebar row to update.
    if (sid == null) return;
    onRunningChangeRef.current?.(sid, running);
  }, []);

  // Owner 2026-10-27 ("deleted chat still sits in the chat if you have it
  // open") — a DELETED chat has no row server-side (or this user lost read
  // access — the backend 404s both identically), so every probe 404s and
  // retrying can never succeed. When a probe that CAN distinguish 404 (a real
  // session GET — coding path) sees it, land in the terminal 'deleted' state:
  // stop the reconnect loop (close stream + clear timers, INCLUDING the
  // busy-queue stream the unmount teardown also closes — review round 1,
  // finding 9), clear live state so the sidebar spinner dies, and render the
  // honest gone copy. The page clears the mount on delete/archive/SSE-notice;
  // this is the view-side belt-and-braces for a chat that died while already
  // mounted (stream drop → reconnect backoff → slow-phase probe 404).
  const markChatDeleted = useCallback((sid: string) => {
    if (activeIdRef.current !== sid) return;
    const es = esRef.current; esRef.current = null; es?.close();
    if (reconnectRef.current.timer) { clearTimeout(reconnectRef.current.timer); reconnectRef.current.timer = null; }
    if (replayTimerRef.current) { clearTimeout(replayTimerRef.current); replayTimerRef.current = null; }
    plainQueueEsRef.current?.close(); plainQueueEsRef.current = null;
    setLive(l => ({ ...l, parts: [], workers: undefined, verify: undefined, status: undefined, steps: undefined, running: false, pendingApproval: null, pendingQuestion: null }));
    setRunning(sid, false);
    purgeSessionSnapshot(sid);
    setLoadFailed('deleted');
  }, [setRunning]);

  // Review round 1, finding 2 (404 ≠ deleted on the CODING path): the coding
  // session GET 404s BOTH for a deleted chat AND for a live chat whose
  // workspace satellite was detached (getSessionForUser returns null when
  // chat.codingState is missing — that's what the cold-load 'no_workspace'
  // arm exists for). Before latching the terminal deleted state from a
  // coding-probe 404, CONFIRM via the plain chat read: getChat 404 ⇒ the chat
  // row is gone/revoked (terminal); getChat 200 ⇒ the chat exists with no
  // satellite ⇒ fall back to the honest no_workspace copy and keep the panel
  // alive (the user can re-attach from the ⋯ menu). Probe errors stay
  // non-terminal (the retry loop continues).
  const confirmCodingChatGone = useCallback(async (sid: string): Promise<'gone' | 'no_workspace' | 'unknown'> => {
    try {
      await crossModelApi.getChat(sid, { messageLimit: 1 });
      return 'no_workspace'; // chat exists, satellite detached
    } catch (e: any) {
      if (e?.response?.status === 404) return 'gone'; // row gone or access revoked
      return 'unknown'; // transient — keep retrying
    }
  }, []);

  const plainRef = useRef(plain);
  useEffect(() => { plainRef.current = plain; });

  // Restored check state (owner report 2026-09-26 — after a refresh the
  // previous run's "Checking…" stayed on screen as if a stream were attached):
  // the LAST assistant row of a restored transcript that still says
  // 'checking' is polled from THIS tab (the original tab's poll died with it)
  // and settled to "Check didn't finish" at the bound. One poll per row id
  // per mount (a focus resync / drain reload must not stack polls). Never a
  // live-stream affordance: the row renders from its metadata.
  const pendingPollRef = useRef<Set<string>>(new Set());
  // The plain send in flight (audit 2026-09-26): its arrival time (first_paint
  // beacon), whether it was a Dig-deeper tap / a council send (quota refresh on
  // settle), and the escalation echo to retract on a refusal.
  const sendStartedRef = useRef<{ at: number; escalationOf?: string; echoId?: string; mode: string } | null>(null);
  const firstPaintSentRef = useRef(false);
  // Stream drops (2026-10-20, lib/stream-drop-beacon.ts): ONE stream_drop beacon
  // per drop episode + ONE stream_resume when it ends (page-capped).
  const dropTrackerRef = useRef(createStreamDropTracker());
  const streamDropCtx = useCallback((sid: string | null, attempts: number): StreamDropContext => {
    const p = plainRef.current;
    const at = sendStartedRef.current?.at;
    return {
      chatId: sid,
      sessionId: p?.guest ? p.guestSessionId : undefined,
      guest: !!p?.guest,
      mode: p?.mode,
      attempts,
      ...(typeof at === 'number' ? { msSinceSend: Date.now() - at } : {}),
    };
  }, []);
  // Guest resume (2026-09-26, guest-resume.ts) as ONE starter: a reopened
  // mid-response guest session (the load effect) AND every guest reattach
  // completion (stream drops 2026-10-20 — the run ended while disconnected, the
  // replay lost its head, or the reattach replayed a run that may be the
  // PREVIOUS turn's) read the answer the session history holds for the
  // trailing question, or wait (bounded) while the run is still live.
  // `streamed` is a reattach's own row: kept only when the history confirms
  // it (guestResumeRowPick, review 2026-10-20).
  const startGuestResume = useCallback((gid: string, seed: CodingMessage[], opts?: { afterDrop?: boolean; streamed?: CodingMessage }) => {
    const token = `${gid}:${Date.now()}`;
    guestResumeRef.current = token;
    const alive = () => guestResumeRef.current === token;
    void resumeGuestSession(gid, seed, {
      fetchState: fetchGuestSessionState,
      shouldContinue: alive,
      onWaiting: () => { if (alive()) setLive({ parts: [], pendingApproval: null, ...guestResumeLiveState() }); },
    }).then((r) => {
      if (!alive()) return;
      guestResumeRef.current = null;
      const pick = guestResumeRowPick(r, opts?.streamed, seed);
      if (pick) {
        // The hydrated row carries the state's chips (the guest's sign-in
        // affordance) — the same control the streaming tab showed.
        const appended: CodingMessage = pick.use === 'streamed' ? pick.row : guestHydratedRow(pick.content, pick.chips);
        setMessages(prev => [...prev, appended]);
        plainRef.current?.onTranscriptChange?.([...messagesRef.current, appended]);
      } else if (r.kind === 'gone' || (opts?.afterDrop && r.kind === 'inactive')) {
        // After a dropped stream (not a reload) an ended run with no saved
        // answer is news to this tab — say so instead of going quiet.
        toast.message('That answer didn’t finish — send your question again.');
      }
      setLive({ parts: [], pendingApproval: null, running: false });
    });
  }, []);
  // Audit sse-ui-restore-14 (2026-09-26): EVERY young pending assistant row the
  // poll can observe is polled (depth-ux-seams.ts pendingRowsToPoll) — not
  // only the last one (a2 'checking' under a later a3 'checked' used to stay
  // "Checking…" forever). A pending row outside the poll's page settles to
  // "Check didn't finish" unless a poll for it is already running.
  const startPendingRowPoll = useCallback((rows: CodingMessage[], sid: string) => {
    const { poll, unreachable } = pendingRowsToPoll(rows);
    const settle = unreachable.filter(m => !pendingPollRef.current.has(m.id)).map(m => m.id);
    if (settle.length) setMessages(prev => settleRowsInterrupted(prev, settle));
    for (const pendingRow of poll) {
      const rowId = pendingRow.id;
      if (pendingPollRef.current.has(rowId)) continue;
      pendingPollRef.current.add(rowId);
      void pollPlainRevision(sid, rowId, (id, o) => crossModelApi.getChat(id, o), { shouldContinue: () => activeIdRef.current === sid })
        .then((row) => {
          if (activeIdRef.current !== sid) return;
          setMessages(prev => prev.map(m => (m.id === rowId ? (row ? { ...row, id: rowId } : { ...m, plainMeta: markCheckInterrupted(m.plainMeta) }) : m)));
        })
        .catch(() => {})
        .finally(() => { pendingPollRef.current.delete(rowId); });
    }
  }, []);
  // The Dig-deeper tap in flight on this stream: its optimistic echo + target.
  // A refusal frame (escalationRefusalPlan) retracts the echo so the chip is
  // not counted as a spent rung; cleared on complete.
  const escalationInFlightRef = useRef<InFlightEscalation | null>(null);

  // Plain mode: the transcript loads via the plain-chat GET and maps into
  // CodingMessage rows (plain-session.ts) — no session/plan/usage fetches.
  const reloadPlain = useCallback(async (sid: string) => {
    try {
      const full = await crossModelApi.getChat(sid, { messageLimit: 50 });
      if (activeIdRef.current !== sid) return;
      setSupervisorChat(!!(full.isSupervisor || full.isProjectSupervisor));
      // MERGE, never replace (owner 2026-09-18): a queued `tmp-*` echo has no
      // server row until the drain runs it, so a replace erased the bubble
      // (see mergeLatestPlainPage). A pending echo whose twin has landed is
      // released from the pending set — in a plain chat that row is the
      // queued turn itself, already in chronological order in history.
      // Restored check state (2026-09-26): settle stale pending rows, poll a
      // young one — same rule as the initial load.
      const restored = settleRestoredRows(mapPlainMessages(full));
      const r = mergeLatestPlainPage(messagesRef.current, restored, pendingSteerIdsRef.current);
      setMessages(r.messages);
      // Ticket c0b2b0c8: reloadPlain must keep server-listed queued rows —
      // mergeLatestPlainPage's dropPrevAbsent handles a drained entry (a prev
      // pending row the fresh page no longer lists), but a still-queued entry
      // arrives here as a fresh `pending-*` row (from full.pendingMessages)
      // and must both survive the merge AND stay in pendingSteerIds so it
      // renders in the queued partition. Union: any queue-entry id the
      // server still lists stays pending; ids whose drain landed get
      // released below by the idMap (echo-twin reconciliation).
      const restoredPending = mapPlainPendingMessages(full);
      // Ticket 81b229e1 ("Send now" showed the message TWICE): the Send-now
      // path promotes the queued row then STOPS the run, and the stop calls
      // this reload while that row is still pending — so the optimistic
      // `tmp-*` echo and the server's `pending-<rowId>` row are the SAME
      // message. reconcileQueuedEchoes cannot merge them (its twin search
      // only sees PERSISTED rows; a queue entry is not persisted until it
      // drains), and the append below deduped by id only, so both survived
      // and the queued partition rendered two identical bubbles.
      // The server row is the record — drop the echo and re-key any pending
      // tracking onto the row id.
      const echoReconcile = reconcilePendingEchoes(
        messagesRef.current,
        restoredPending,
        { isQueueEcho: isPlainQueueEchoId, echoToPending: plainEchoToPendingRef.current },
      );
      const replacedEchoIds = new Set(echoReconcile.idMap.keys());
      // The pairing has been applied (or the row is gone) — forget it so the map
      // cannot grow for the life of the session.
      for (const id of replacedEchoIds) plainEchoToPendingRef.current.delete(id);
      // One atomic commit: drop the superseded echoes, then append the
      // server-listed queue rows that are not already present.
      const mergedBase = r.messages.filter(m => !replacedEchoIds.has(m.id));
      const baseIds = new Set(mergedBase.map(m => m.id));
      const appendedPending = restoredPending.filter(m => !baseIds.has(m.id));
      const finalMessages = appendedPending.length ? [...mergedBase, ...appendedPending] : mergedBase;
      setMessages(finalMessages);
      const listedPendingIds = new Set(restoredPending.map(m => m.id));
      // Union, not replace: keep every prev id that is still present in the
      // merged transcript and not yet twin-reconciled (local tmp-*/steer-*
      // echoes the server has not persisted land here — dropping them would
      // un-queue a just-sent bubble on mid-run reload, the exact defect this
      // ticket fixes), then add the server-listed queued rows. A drained
      // pending-<rowId> is absent from r.messages → released. (reviewer MAJOR)
      const mergedIds = new Set(finalMessages.map(m => m.id));
      setPendingSteerIds(prev => {
        const next = new Set<string>();
        // A superseded echo is gone from the transcript — release it so the
        // queued partition cannot keep rendering a bubble nothing maps to.
        for (const id of prev) {
          if (replacedEchoIds.has(id)) continue;
          if (mergedIds.has(id) && !r.idMap.has(id)) next.add(id);
        }
        for (const id of listedPendingIds) next.add(id);
        return next;
      });
      startPendingRowPoll(restored, sid);
      // Reload replaces the transcript with the newest page — re-seed the
      // paging envelope so "Load earlier" pages from the fresh cursor (H2).
      setPlainPaging({ hasMore: !!full.hasMoreMessages, cursor: full.nextMessagesBefore ?? null });
      // Ticket ce78ab80 (review MAJOR-2): this is server-confirmed history too,
      // so refresh the re-open snapshot — otherwise a remount right after a
      // focus-resync/stop paints the transcript as it was before this reload.
      // Ticket 81b229e1: it must carry the SAME deduped array committed above,
      // or a remount would paint the duplicate bubble straight back.
      refreshPlainSnapshotMessages(sid, finalMessages);
    } catch { /* leave current state */ }
  }, [startPendingRowPoll]);

  // Fetch the next OLDER plain-transcript page and PREPEND it (review H2 —
  // the old "Load earlier" only re-sliced the locally-loaded array, so
  // anything past the first 50 messages was unreachable). Ports page.tsx's
  // loadEarlierMessages: snapshot the viewport, prepend, restore by the
  // scrollHeight delta post-render, and unpin so the autoscroll/RO stick
  // can't yank the restored view back to the bottom.
  const loadEarlierPlain = useCallback(async () => {
    const sid = activeIdRef.current;
    const cursor = plainPaging.cursor;
    if (!sid || !cursor || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await crossModelApi.getChat(sid, { messageLimit: 50, messagesBefore: cursor });
      if (activeIdRef.current !== sid) return; // switched chats mid-flight
      const older = mapPlainMessages(page);
      pinnedRef.current = false;
      const el = scrollRef.current;
      prependScrollRef.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
      setMessages(prev => [...older, ...prev]);
      // Widen the local window by the prepended count, or the new rows would
      // stay hidden behind the last-N slice.
      setVisibleCount(c => c + older.length);
      setPlainPaging({ hasMore: !!page.hasMoreMessages, cursor: page.nextMessagesBefore ?? null });
    } catch {
      toast.error('Could not load earlier messages.');
    } finally {
      setLoadingEarlier(false);
    }
  }, [plainPaging.cursor, loadingEarlier]);

  // Apply a coding getSession response to state + the remount snapshot. With
  // `merge` the newest-page response UNIONS into the loaded transcript (older
  // prepended pages survive, local echoes are dropped) instead of clobbering
  // it — the pre-paging replace semantics would nuke rows the user paged in.
  const applyFetchedSession = useCallback((sid: string, full: Awaited<ReturnType<typeof codingApi.getSession>>, opts?: { merge?: boolean }) => {
    setActiveSession(full);
    if ((full as any).project) setProject((full as any).project);
    // Durable whole-session usage totals (server-computed) — the meter shows
    // real numbers immediately on open, even before any run this visit.
    const su = (full as any).sessionUsage;
    if (su && (su.inTokens || su.outTokens)) setSessionUsage(su);
    // Agent-configured UI prefs: seed the preview port a dev server declared.
    const ui = (full as any).uiState;
    if (ui?.previewPort) setPreviewDefaultPort(Number(ui.previewPort));
    const fetched = bridgeCodingMeta(full.messages || []);
    let merged = fetched;
    if (opts?.merge) {
      const r = mergeLatestTranscriptPage(messagesRef.current, fetched, pendingSteerIdsRef.current);
      merged = r.messages;
      // A queued echo now has a persisted twin: keep the QUEUED slot by
      // pointing the pending set at the server id (cleared on run complete).
      if (r.idMap.size) setPendingSteerIds(prev => { const next = new Set<string>(); for (const id of prev) next.add(r.idMap.get(id) ?? id); return next; });
    }
    setMessages(merged);
    const paging = { hasMore: !!full.hasMoreMessages, cursor: full.nextMessagesBefore ?? null };
    setCodingPaging(paging);
    writeSessionSnapshot(sid, { session: full, project: (full as any).project ?? null, messages: merged, paging, sessionUsage: su ?? null });
  }, []);

  const reloadSession = useCallback(async (sid: string) => {
    if (plainRef.current) { await reloadPlain(sid); return; }
    try {
      const full = await codingApi.getSession(sid, { messageLimit: CODING_PAGE });
      if (activeIdRef.current !== sid) return;
      applyFetchedSession(sid, full, { merge: true });
    } catch { /* leave current state */ }
    codingApi.getPlan(sid).then(p => { if (activeIdRef.current === sid) setPlan(p); }).catch(() => {});
  }, [reloadPlain, applyFetchedSession]);

  // Coding counterpart of loadEarlierPlain: fetch the next OLDER transcript
  // page and PREPEND it (coding transcripts were unpaged before 2026-08-31, so
  // "Load earlier" could only re-slice local rows — anything past the first
  // CODING_PAGE messages was unreachable).
  const loadEarlierCoding = useCallback(async () => {
    const sid = activeIdRef.current;
    const cursor = codingPaging.cursor;
    if (!sid || !cursor || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await codingApi.getSession(sid, { messageLimit: CODING_PAGE, messagesBefore: cursor });
      if (activeIdRef.current !== sid) return; // switched chats mid-flight
      const older = bridgeCodingMeta(page.messages || []);
      pinnedRef.current = false;
      const el = scrollRef.current;
      prependScrollRef.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
      setMessages(prev => [...older, ...prev]);
      // Widen the local window by the prepended count, or the new rows would
      // stay hidden behind the last-N slice (capped — see MAX_VISIBLE).
      setVisibleCount(c => Math.min(c + older.length, MAX_VISIBLE));
      setCodingPaging({ hasMore: !!page.hasMoreMessages, cursor: page.nextMessagesBefore ?? null });
    } catch {
      toast.error('Could not load earlier messages.');
    } finally {
      setLoadingEarlier(false);
    }
  }, [codingPaging.cursor, loadingEarlier]);

  // ONE "load earlier" step (the old button's logic): reveal the next local
  // window first (anchoring the viewport like a server prepend does), then
  // fetch+prepend the next OLDER server page. Held in a ref so the
  // IntersectionObserver below never re-arms on every history change.
  const loadEarlierRef = useRef<() => void>(() => {});
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const earlierCooldownRef = useRef(0);

  const connectStream = useCallback((sid: string | null, message: string, opts?: { attach?: boolean; url?: string }) => {
    esRef.current?.close();
    firstPaintSentRef.current = false;
    if (reconnectRef.current.timer) { clearTimeout(reconnectRef.current.timer); reconnectRef.current.timer = null; }
    // Plain mode: one normalizer per connection — it accumulates the answer so
    // the payload-less legacy `complete` can synthesize the coding finalText.
    // A `task` frame for a taskId a PERSISTED row already carries updates that
    // row (the handler below) and must not also ride this turn's parts.
    const normalize = plainRef.current ? makeLegacyNormalizer({ hasTask: (id) => messagesHaveTask(messagesRef.current, id) }) : null;
    // Plain ATTACHES (no opts.url) must hit the plain chat stream endpoint —
    // codingApi.streamUrl is the coding-sessions URL and 404s for a plain chat
    // (increment-1 bug: attachOnLoad/resync/error-reconnect all rode it).
    // Coding attaches send the resume cursor (0c158104) so the server replays
    // only events PAST the last frame this client rendered, not the whole log;
    // a fresh run start clears the stale cursor first.
    if (!opts?.attach && !plainRef.current && sid) clearStreamSeq(sid);
    // Browser panel (Phase 6a): a FULL replay (plain attach — no cursor exists;
    // coding attach without a resume cursor) rebuilds the activity log from the
    // replayed events, so clear first or every re-attach doubles the rows —
    // the same discipline as the live-parts wipes around these attach paths.
    // A cursor resume replays only unseen events; the log carries forward.
    if (opts?.attach && (plainRef.current || !sid || !storedStreamSeq(sid))) resetBrowserActivity();
    // sid is null ONLY for C3 chatless plain sends, which ALWAYS pass opts.url
    // (the built /crossmodel/stream send URL) — the attach/coding branches below
    // are unreachable then, so their non-null assertions are safe.
    const es = new EventSource(opts?.url ?? (plainRef.current ? buildPlainAttachUrl(sid!) : codingApi.streamUrl(sid!, message, opts?.attach ? storedStreamSeq(sid!) : undefined)));
    esRef.current = es;
    // bg-ES handoff: the page closes any page-level EventSource it still holds
    // for this chat — exactly one consumer of the stream from here on.
    if (plainRef.current && sid) plainRef.current.onStreamClaim?.(sid);
    let terminal = false;
    // Stream drops (2026-10-20): a GUEST reattach (GET /session/:id/stream) —
    // when it cannot deliver the whole answer (the run ended while we were
    // disconnected ⇒ complete{interrupted}, or the replay lost its head ⇒ a
    // 'truncated' progress frame), the answer is read from the session history.
    const guestAttachId = opts?.attach && sid == null ? guestReconnectSessionId(plainRef.current, sid) : null;
    let replayTruncated = false;
    // 0c158104: an attach replays the run's persisted event log; the server
    // marks the end of the backlog with a `replay_end` frame. Gate per-frame
    // autoscroll for the WHOLE replay — any duration — so the view lands ONCE
    // when it drains instead of chasing a moving bottom through messages the
    // user already saw. The gate closes on `replay_end`, on a terminal frame,
    // or on a 6s safety for servers that predate the marker; frames after the
    // gate are LIVE and follow the normal pinned autoscroll (the old reviewer
    // catch that killed the connection-lifetime gate: dense live streams must
    // keep follow-scroll).
    let replayGate = !!opts?.attach;
    // Replay render-batching (2026-08-31): a fresh-mount attach replays the
    // WHOLE run log — even after server-side frame merging that's hundreds of
    // SSE frames, and one setLive per frame meant a full transcript render +
    // react-markdown re-parse of the accumulated answer PER FRAME (O(n²) on the
    // backlog length — the multi-second freeze on reopening a long session).
    // While the replay gate is open, live-state updates QUEUE and flush as one
    // setState every 100ms (plus a final flush when the gate closes); frames
    // after the backlog render per-event as before. Correctness is unaffected —
    // every queued update still applies, in order.
    const stale = () => activeIdRef.current !== sid;
    const liveQueue: Array<(l: LiveRun) => LiveRun> = [];
    let liveFlushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushLiveQueue = () => {
      if (liveFlushTimer) { clearTimeout(liveFlushTimer); liveFlushTimer = null; }
      if (!liveQueue.length || stale()) return;
      const fns = liveQueue.splice(0, liveQueue.length);
      setLive(l => { for (const fn of fns) l = fn(l); return l; });
    };
    const queueLive = (fn: (l: LiveRun) => LiveRun) => {
      if (!replayGate) { setLive(fn); return; }
      liveQueue.push(fn);
      if (!liveFlushTimer) liveFlushTimer = setTimeout(flushLiveQueue, 100);
    };
    const gateSafety = opts?.attach
      ? setTimeout(() => { replayGate = false; flushLiveQueue(); }, 6000)
      : null;
    const closeReplayGate = () => { replayGate = false; if (gateSafety) clearTimeout(gateSafety); flushLiveQueue(); };
    const finish = () => { es.close(); if (esRef.current === es) esRef.current = null; };
    const cap = (parts: MessagePart[]) => parts.length > MAX_LIVE_PARTS ? parts.slice(parts.length - MAX_LIVE_PARTS) : parts;
    // Every new part gets a stable uid so React keys survive cap()'s
    // front-slice and the tool_call→result merge (index keys re-keyed the
    // whole live transcript on every event past the cap — visible churn).
    // ts = client ingest time for the per-block hover timestamp (the backend
    // stamps persisted parts at push time; mergeDeltaIntoParts only stamps
    // NEW parts, so a text block keeps its first-delta time).
    // Frame wall-clock (2026-09-08): the server stamps every frame with the
    // event's real time (`ts`), so an attach-replay shows WHEN each block
    // happened instead of the ingest time — an attach at 7:28 used to render
    // "7:28 AM" on every block of a run that began at 7:19. Captured per
    // frame (queueLive callbacks run later, during replay batching).
    let frameTs: string | undefined;
    const stamp = (p: MessagePart, ts: string | undefined = frameTs): MessagePart => ({ ...p, uid: `p${++partSeqRef.current}`, ts: ts ?? new Date().toISOString() } as MessagePart);
    const appendDelta = (kind: 'text' | 'reasoning', delta: string, label?: string) => {
      const ts = frameTs;
      // ux_beacon first_paint (audit 2026-09-26 guest-persistence-4): the first
      // visible text of a plain send, measured from the send click.
      if (kind === 'text' && delta && plainRef.current && !opts?.attach && !firstPaintSentRef.current) {
        firstPaintSentRef.current = true;
        const startedAt = sendStartedRef.current?.at;
        if (startedAt) sendUxBeacon({ event: 'first_paint', chatId: sid ?? undefined, sessionId: plainRef.current.guestSessionId, ms: Date.now() - startedAt, mode: plainRef.current.mode });
      }
      queueLive(l => {
        // Per-label reasoning coalescing (owner report 2026-08-30) — see
        // lib/reasoning-merge.ts. The old trailing-only label-keyed merge
        // fragmented interleaved concurrent personas into dozens of one-word
        // "Thought process" rows per turn.
        return { ...l, parts: cap(mergeDeltaIntoParts(l.parts, kind, delta, { label, stamp: (p) => stamp(p, ts) })) };
      });
    };
    const pushPart = (p: MessagePart) => { const ts = frameTs; queueLive(l => ({ ...l, parts: cap([...l.parts, stamp(p, ts)]) })); };
    es.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
      let { type, data } = msg;
      frameTs = typeof msg?.ts === 'string' && msg.ts ? msg.ts : undefined;
      if (stale()) return;
      // Reopened mid-reply (owner 2026-10-08: "reopened but it is not showing where it was"): an attach mounts the
      // clock at Date.now(), but the replayed frames carry the SERVER time they were sent — the earliest one is when
      // the run really started, so the clock resumes from there instead of restarting at 0 (lib/run-clock.ts).
      if (opts?.attach) {
        const startedMs = replayedRunStart(frameTs);
        if (startedMs != null) setRunStart(rs => (rs == null || startedMs < rs ? startedMs : rs));
      }
      // Terminal fence (P2 item 5): a frame delivered after 'complete'/'error'
      // (a replayed/mirrored terminal on the same connection racing es.close())
      // must never re-run the complete handler — a second run through it would
      // append a SECOND assistant bubble for the same answer.
      if (terminal) return;
      // Stream drops (2026-10-20): the first frame of a reattach closes an open
      // drop episode (one stream_resume beacon); an immediate interrupted
      // complete means the run had already ended.
      if (opts?.attach && dropTrackerRef.current.episodeOpen) {
        dropTrackerRef.current.resume(streamDropCtx(sid, reconnectRef.current.attempts), type === 'complete' && data?.interrupted ? 'ended' : 'resumed');
      }
      if (type === 'progress' && data?.stage === 'truncated') replayTruncated = true;
      // 0c158104: track the resume cursor (coding only — plain-chat frames carry
      // no run-scoped ids) and remember the PREVIOUS one so an `init` below can
      // tell a run SWITCH (clear + rebuild) from a same-run generation boundary.
      const prevSeq = plainRef.current || !sid ? undefined : storedStreamSeq(sid);
      if (ev.lastEventId && !plainRef.current && sid) noteStreamSeq(sid, ev.lastEventId);
      if (normalize) {
        // Page-level features with no coding-vocabulary equivalent.
        // C3 (ticket 71b1fec6): GUEST sessions have no workspace panel — fold
        // the canvas event's content into the answer as a text delta (content
        // preservation; the sign-up CTA replaces the panel) instead of the
        // page's onCanvas panel feed. '' → drop (nothing usable).
        if (type === 'canvas') {
          if (plainRef.current?.guest) {
            const canvasText = canvasEventToText(data);
            if (!canvasText) return;
            type = 'chunk'; data = { content: canvasText };
          } else {
            plainRef.current?.onCanvas?.(data); return;
          }
        }
        if (type === 'queued') { toast.info('This chat is busy — your message is queued and runs automatically when the current turn finishes.'); return; }
        // iMessage confirm card (E5, 2026-09-25): page-level dialog, not a
        // transcript part — forward, never normalize (the bridge drops it).
        if (type === 'imessage-draft') { plainRef.current?.onImessageDraft?.(data); return; }
        const n = normalize(type, data);
        if (!n) return;
        type = n.type; data = n.data;
      }
      reconnectRef.current.attempts = 0;
      // The server's backlog boundary marker: close the autoscroll gate —
      // frames after this are LIVE and follow the normal pinned autoscroll.
      if (type === 'replay_end') { closeReplayGate(); return; }
      // During the replayed backlog (any duration) gate per-frame autoscroll so
      // the view lands ONCE when it drains instead of chasing the bottom through
      // messages the user already saw; live frames follow normally.
      if (replayGate && (type === 'text' || type === 'reasoning' || type === 'tool_call' || type === 'tool_result')) noteReplayActivity();
      if (type === 'init') {
        if (data.startedAt) setRunStart(data.startedAt);
        // Run SWITCH (0c158104): the stream is replaying a DIFFERENT run than
        // the rendered parts belong to (a stale foreign-run cursor) — clear and
        // rebuild. A same-run init keeps the transcript: on an attach full
        // replay the parts are empty already, and a mid-run resumed generation
        // continues the same visual turn (its pre-init events are NOT re-sent).
        const frameRun = typeof ev.lastEventId === 'string' && ev.lastEventId.includes(':') ? ev.lastEventId.split(':')[0] : '';
        const prevRun = prevSeq && prevSeq.includes(':') ? prevSeq.split(':')[0] : '';
        if (frameRun && prevRun && frameRun !== prevRun) { queueLive(l => ({ ...l, parts: [], workers: undefined })); resetBrowserActivity(); }
      }
      else if (type === 'text') appendDelta('text', data.delta || '');
      // Thinking stays hidden (2026-10-04, lib/reasoning-visibility.ts) — a replayed pre-change frame is dropped.
      else if (type === 'reasoning') { if (reasoningVisible()) appendDelta('reasoning', data.delta || '', data.label); }
      else if (type === 'tool_call') pushPart({ type: 'tool_call', name: data.name, args: data.args, ...(typeof data.label === 'string' && data.label ? { label: data.label } : {}) });
      else if (type === 'tool_result') pushPart({ type: 'tool_result', name: data.name, result: data.result, ...(typeof data.label === 'string' && data.label ? { label: data.label } : {}) });
      // Screenshots in the chat (2026-09-23): the final browser/computer frame
      // lands as an inline image part right after its tool card. Generated
      // images (2026-09-24 review): the shared mapping keeps url / fileId /
      // prompt (Download / Open row live, not only after a reload) and accepts
      // a url-only replayed frame (the durable log strips the base64).
      else if (type === 'image') { const imagePart = imagePartFromFrame(data); if (imagePart) pushPart(imagePart); }
      // Harness draft retraction (2026-09-08): the zero-tool gate discarded the
      // draft that just streamed — retract exactly those trailing text chars so
      // the live view stops showing a fabrication the loop never accepted
      // (byte-parity with run-executor's persisted partial).
      else if (type === 'draft_discarded') queueLive(l => ({ ...l, parts: trimTrailingTextParts(l.parts, Number(data?.chars) || 0) }));
      // Harness guard marker: its own callout part; struckPrev flags the
      // rejected candidate before it so it renders collapsed as "not submitted".
      else if (type === 'guard_marker') { const ts = frameTs; queueLive(l => ({ ...l, parts: cap(appendGuardMarkerParts(l.parts, String(data?.text || ''), !!data?.struckPrev, (p) => stamp(p, ts))) })); }
      else if (type === 'browser_observation') {
        // Browser program (Phase 6a): retain the per-action browse stream
        // (action/url/preview + the separate screenshot frame) instead of
        // collapsing it to one progress line. Replayed frames rebuild the log
        // silently; only LIVE frames drive the surfaces — the mobile sheet
        // auto-open (ChatGPT pattern, dismissal sticks) and a one-time panel
        // tab focus on the conversation's first observation.
        const first = !hadBrowserActivityRef.current;
        hadBrowserActivityRef.current = true;
        setBrowserActivity(prev => reduceBrowserActivity(prev, data));
        if (!replayGate) {
          setBrowserSheet(s => nextBrowserSheetState(s, 'observation'));
          // Deferred past the React commit: WorkspacePanel's section-switch
          // listener checks its CURRENT sections prop, and the 'browser'
          // section only exists after this state update renders — a
          // synchronous dispatch would be ignored as an unknown id.
          if (first) setTimeout(() => openWorkspaceSection('browser'), 0);
        }
      }
      else if (type === 'subagent_start') queueLive(l => ({ ...l, workers: [...(l.workers || []), { role: data.role || 'worker', title: data.title || data.role || 'task', done: false }] }));
      else if (type === 'subagent_end') queueLive(l => {
        const workers = (l.workers || []).slice();
        const i = workers.findIndex(w => !w.done && w.title === (data.title || '') && w.role === (data.role || 'worker'));
        const j = i >= 0 ? i : workers.findIndex(w => !w.done);
        if (j >= 0) workers[j] = { ...workers[j], done: true };
        return { ...l, workers };
      });
      else if (type === 'session_title') {
        if (data.title) {
          setActiveSession(prev => prev ? { ...prev, title: data.title } : prev);
          if (sid) onTitleChangeRef.current?.(sid, data.title);
          // Guest sessions (2026-09-26): a chatId-less run's server title lands
          // on the browser-local record (the rail kept the raw first message).
          else if (plainRef.current?.guestSessionId) plainRef.current.onGuestTitle?.(plainRef.current.guestSessionId, String(data.title));
        }
      }
      else if (type === 'plan_update') { if (data.plan) setPlan(data.plan); }
      // Depth UX (2026-09-26): the harness's check pill for the streaming turn
      // (plain chats; the normalizer already validated the payload).
      else if (type === 'check_state') queueLive(l => ({ ...l, check: reduceCheckState(l.check, data) }));
      // Inline task card (cohesive chat, 2026-09-28 — lib/task-card.ts): the
      // harness's task lifecycle frame. ONE card per task: when a persisted
      // row already carries this taskId (a background continuation / a
      // sub-session reporting on the turn that started it) the frame updates
      // THAT row's card; otherwise it rides the live parts (upsert in place —
      // the card never remounts on an update). The plain normalizer already
      // validated the payload; coding runs deliver it raw, so parse here too.
      // A 'waiting_user' card focuses the composer once, on a LIVE frame.
      else if (type === TASK_EVENT_TYPE) {
        const task = parseTaskEvent(data);
        if (task) {
          const ts = frameTs;
          if (messagesHaveTask(messagesRef.current, task.taskId)) {
            setMessages(prev => applyTaskToMessages(prev, task));
          } else {
            queueLive(l => ({ ...l, parts: cap(upsertTaskPartParts(l.parts, task, (p) => stamp(p, ts))) }));
          }
          if (task.status === 'waiting_user' && !replayGate) setTimeout(() => { if (!stale()) composerRef.current?.focus(); }, 0);
        }
      }
      else if (type === 'steer') {
        if (data.message) pushPart({ type: 'text', text: `↳ steering: ${data.message}` });
        if (Array.isArray(data.images)) for (const img of data.images) pushPart({ type: 'image', mediaType: img.mediaType, data: img.data, name: img.name });
      }
      else if (type === 'process_update') { if (Array.isArray(data.processes)) queueLive(l => ({ ...l, processes: data.processes })); }
      else if (type === 'loop_update') queueLive(l => ({ ...l, loop: { kind: data.kind, round: data.round, max: data.max, detail: data.detail } }));
      else if (type === 'preview_ready') {
        // Honor a preview_ready ONCE per port — subscribeRun replays the whole
        // ring buffer on every reconnect/attach, so without this the preview
        // would snap back on and reload (clobbering a port the user changed or
        // a preview they turned off) on every network blip. First occurrence
        // per port only; a genuinely new port (agent restarted on another one)
        // still fires.
        const port = Number(data.port);
        if (port && port !== appliedPreviewPortRef.current) {
          appliedPreviewPortRef.current = port;
          setPreviewHint({ port, ts: Date.now() });
        }
      }
      else if (type === 'context') {
        const usage: RunUsage | undefined = data.usage;
        if (data.sessionUsage) setSessionUsage(data.sessionUsage);
        if (usage && usage.runId) {
          const prev = lastRunTotalRef.current;
          const total = usage.totalInTokens + usage.totalOutTokens;
          setLastAddedTokens(prev.runId === usage.runId ? Math.max(0, total - prev.total) : total);
          lastRunTotalRef.current = { runId: usage.runId, total };
        }
        queueLive(l => ({ ...l, context: { chars: data.chars || 0, budget: data.budget || 1, compactions: data.compactions || 0, usage: usage || l.context?.usage } }));
      }
      else if (type === 'progress') {
        // Throttle: per-token thinking summaries otherwise swap the status text
        // dozens of times a second (rapid text flicker in the working line).
        // Harness-stage notices are NEVER dropped (2026-09-08): a replayed
        // burst arrives ms apart, and the drop-throttle silently lost the
        // "draft discarded" / "rejected back" status lines.
        const urgent = typeof data.stage === 'string' && URGENT_PROGRESS_STAGES.has(data.stage);
        if (data.message) {
          const applyStatus = (msg: string) => {
            statusAtRef.current = Date.now();
            queueLive(l => (l.status === msg ? l : { ...l, status: msg, steps: appendThinkingStep(l.steps, msg) }));
          };
          const sinceLast = Date.now() - statusAtRef.current;
          // A REPLAYED backlog (reopening a chat mid-reply) delivers the whole status history within milliseconds —
          // the throttle kept only its first and last line (usually a hidden heartbeat), so the reopened view lost
          // every step. Replay frames are batched by queueLive anyway: apply each one so the step list is rebuilt.
          if (urgent || replayGate || sinceLast > 300) {
            if (statusTrailRef.current) { clearTimeout(statusTrailRef.current); statusTrailRef.current = null; }
            applyStatus(data.message);
          } else {
            // TRAILING EDGE (owner 2026-09-15 "it looks like only the double
            // checker runs"): a drop-throttle lost the LAST line of a burst —
            // "Digby is digging in — checkers running in parallel…" arrived a
            // few ms after "Digby is dispatching the Double Checker…" and
            // vanished, so the status read as a sequential hand-off. The
            // newest message of a burst now lands when the window closes.
            if (statusTrailRef.current) clearTimeout(statusTrailRef.current);
            const msg: string = data.message;
            statusTrailRef.current = setTimeout(() => { statusTrailRef.current = null; applyStatus(msg); }, Math.max(1, 300 - sinceLast));
          }
        }
      }
      else if (type === 'verify_start') queueLive(l => ({ ...l, verify: { stages: (data.stages || []).map((k: string) => ({ key: k, passed: false })), running: true } }));
      else if (type === 'verify_result') queueLive(l => ({ ...l, verify: { stages: data.stages || [], running: false, passed: !!data.passed, failedStage: data.failedStage ?? null } }));
      // Deploy/PR/push/schedule toasts (ticket 9d07fd1f, owner 2026-10-19
      // "minimalistic quiet front end"): these machine-pipeline events no
      // longer toast — the transcript keeps carrying them. The durable record
      // lives in the session view itself: the final answer names the PR/branch
      // (PR #, branch, next-run time) with clickable links, and the Agent
      // Workbench / jobs surfaces show the pipeline state on demand. The
      // frames are kept as no-ops (not deleted) so the stream contract and
      // any cursor/replay behavior stay byte-identical server-side.
      else if (type === 'pr_opened') { /* quiet (9d07fd1f): no toast — the answer links the PR */ }
      else if (type === 'branch_pushed') { /* quiet (9d07fd1f): no toast — the answer names the branch */ }
      else if (type === 'stopped') queueLive(l => ({ ...l, stopping: true }));
      else if (type === 'permission_request') queueLive(l => ({ ...l, pendingApproval: { approvalId: data.approvalId, tool: data.tool, args: data.args } }));
      else if (type === 'permission_resolved') queueLive(l => ({ ...l, pendingApproval: null }));
      else if (type === 'ask_user') { setQuestionPicks(new Set()); queueLive(l => ({ ...l, pendingQuestion: pendingQuestionFromEvent(data) })); }
      else if (type === 'ask_user_resolved') queueLive(l => ({ ...l, pendingQuestion: null }));
      else if (type === 'schedule_update') { /* quiet (9d07fd1f): no toast — the answer names the next run; Schedules section shows it */ }
      else if (type === 'complete') {
        terminal = true;
        if (statusTrailRef.current) { clearTimeout(statusTrailRef.current); statusTrailRef.current = null; } // no stale status after the run ends
        finish();
        closeReplayGate();
        // Title catch-up (owner 2026-09-22: a new chat kept its raw first
        // message as the sidebar title although the server had generated one).
        // The 'chat-title' frame fires early in a first turn; a long tool-heavy
        // run outlives the attach replay window and reconnects, so it can be
        // missed. (1) The server echoes the title as `autoTitle` on complete —
        // apply it. (2) If the title we hold still looks like the placeholder,
        // ask the server for the real one once the run has settled.
        if (sid) {
          const echoed = typeof data?.autoTitle === 'string' ? data.autoTitle.trim() : '';
          if (echoed) {
            setActiveSession(prev => prev ? { ...prev, title: echoed } : prev);
            onTitleChangeRef.current?.(sid, echoed);
          } else {
            const firstUser = messagesRef.current.find(m => m.role === 'user');
            const heldTitle = activeSessionRef.current?.title ?? '';
            if (isPlaceholderChatTitle(heldTitle, typeof firstUser?.content === 'string' ? firstUser.content : '')) {
              setTimeout(() => {
                if (activeIdRef.current !== sid) return;
                crossModelApi.getChat(sid, { messageLimit: 1 }).then((full: any) => { // title only — never the legacy full transcript (2026-10-20)
                  const t = typeof full?.title === 'string' ? full.title.trim() : '';
                  if (!t || activeIdRef.current !== sid) return;
                  if (isPlaceholderChatTitle(t, typeof firstUser?.content === 'string' ? firstUser.content : '')) return;
                  setActiveSession(prev => prev ? { ...prev, title: t } : prev);
                  onTitleChangeRef.current?.(sid, t);
                }).catch(() => { /* best-effort — the next chat-list load shows the real title */ });
              }, 2500);
            }
          }
        } else if (plainRef.current?.guestSessionId) {
          // Guest sessions (2026-09-26): the autoTitle echo is a guest's only
          // second chance (no title endpoint for sessions) — apply it to the
          // browser-local record; the page keeps a title it already holds.
          const echoed = typeof data?.autoTitle === 'string' ? data.autoTitle.trim() : '';
          if (echoed) plainRef.current.onGuestTitle?.(plainRef.current.guestSessionId, echoed);
        }
        // Per-chat Files section (57ef1b9f PR2): the run is done — refetch so
        // uploads attached to the last steer message and any documents the
        // agent created this turn appear.
        setFilesRefreshKey(k => k + 1);
        // A settled Dig-deeper tap / council send re-reads the daily quota so the
        // research chip greys in-session (audit 2026-09-26 routing-unify-2).
        if (sendStartedRef.current && (sendStartedRef.current.escalationOf || sendStartedRef.current.mode === 'deep_research')) plainRef.current?.onDepthRunSettled?.();
        // Keep the streamed live parts on screen until the reloaded messages
        // land — wiping them here made the finished answer VANISH for the
        // reload round-trip and reappear (the per-message flicker). Also keep
        // `context` so the meter survives run end.
        setLive(l => ({ ...l, pendingApproval: null, running: false, stopping: false }));
        setRunning(sid, false);
        // Run ended — CODING steer bubbles become plain history (the server
        // persisted them eagerly). A PLAIN busy-queue echo has NO server row
        // yet (the drain persists it when its turn runs), so it stays pending
        // — the bubble keeps its slot until reloadPlain finds the twin and
        // releases it (owner 2026-09-18). Only an echo that can never be
        // reconciled (empty text: attachment-only send) is released here.
        if (plainRef.current) {
          setPendingSteerIds(prev => {
            if (!prev.size) return prev;
            const next = new Set<string>();
            for (const id of prev) { const m = messagesRef.current.find(x => x.id === id); if (m && String(m.content ?? '').trim()) next.add(id); }
            return next.size === prev.size ? prev : next;
          });
        } else {
          setPendingSteerIds(new Set());
        }
        // Plain drain check (P2 increment 2): a message queued behind this run
        // (busy-queue passthrough, another device, or a schedule) drains into a
        // NEW run within a beat — the liveness key releases BEFORE the drain
        // re-claims it, so probe once after a short delay and attach if a
        // follow-up turn started (a false negative costs one harmless GET).
        if (plainRef.current && sid) {
          setTimeout(async () => {
            if (activeIdRef.current !== sid || esRef.current) return;
            const active = await fetchPlainRunActive(sid);
            // Tri-state: attach only on a definitive TRUE — null (transient
            // probe failure) and false both skip; the next resync re-probes.
            if (active !== true || activeIdRef.current !== sid || esRef.current) return;
            reconnectRef.current.attempts = 0;
            setLive(l => ({ ...l, parts: [], workers: undefined, running: true, check: undefined, steps: undefined }));
            setRunStart(rs => rs ?? Date.now());
            setRunning(sid, true);
            connectStream(sid, '', { attach: true });
          }, 1500);
        }
        if (opts?.attach && sid) {
          if (data.interrupted) toast.message('The previous run was interrupted — you can continue.');
          reloadSession(sid).finally(() => {
            if (activeIdRef.current === sid) setLive(l => ({ ...l, parts: [], workers: undefined, verify: undefined, status: undefined, steps: undefined, check: undefined }));
          });
        } else if (sid && completePartsOmitted(data)) {
          // audit 2026-10-06 T8-7: the server omitted an oversized `parts` (the final row is already
          // persisted) — load it through the REST transcript read like the attach branch; the live
          // parts stay on screen until it lands, so the answer never blinks out.
          escalationInFlightRef.current = null;
          reloadSession(sid).finally(() => {
            if (activeIdRef.current === sid) setLive(l => ({ ...l, parts: [], workers: undefined, verify: undefined, status: undefined, steps: undefined, check: undefined }));
          });
        } else if (guestAttachId) {
          // Guest reattach (stream drops 2026-10-20): EVERY completion resolves
          // against the session history (startGuestResume matches the
          // transcript's trailing question) — never appended as is. The attach
          // can replay a run that is the PREVIOUS turn's (a retained finished
          // run, a just-finished mirror; review 2026-10-20) and nothing in the
          // stream says which question it answered. An interrupted / handed-off
          // / truncated one (nothing live to attach to, or the cross-box replay
          // lost its head) has no candidate; a whole one offers its streamed row
          // (sources / follow-ups), kept only when the history says it IS this
          // turn's answer (guestResumeRowPick).
          const whole = !(data?.interrupted === true || data?.handedOff === true || replayTruncated);
          const meta = whole && normalize && plainRef.current ? buildPlainMeta(data, plainRef.current.mode) : undefined;
          const streamed: CodingMessage | undefined = whole
            ? { id: `a-${Date.now()}`, role: 'assistant', content: data.finalText || '', parts: data.parts || [], createdAt: new Date().toISOString(), ...(meta ? { plainMeta: meta } : {}) }
            : undefined;
          startGuestResume(guestAttachId, messagesRef.current, { afterDrop: true, ...(streamed ? { streamed } : {}) });
        } else {
          // Plain complete carries the legacy metadata payload (sources /
          // followUps / models — review M2): attach it as plainMeta so the
          // just-answered turn shows Sources pills, follow-up chips, and the
          // admin More-info panel without a reload. Coding: normalize is null
          // and buildPlainMeta never runs — the append is unchanged.
          escalationInFlightRef.current = null; // the escalation ran — its echo is a real spent rung
          const meta = normalize && plainRef.current ? buildPlainMeta(data, plainRef.current.mode) : undefined;
          // Coding completions carry the run's provenance (2026-09-15) so a
          // just-finished machine note folds without a reload.
          const provenance = !meta && (typeof data.origin === 'string' || typeof data.triggerKind === 'string')
            ? { origin: data.origin as string | undefined, triggerKind: data.triggerKind as string | undefined }
            : undefined;
          // The persisted row id when the backend carries it (owner 2026-09-18):
          // the late cross-check revises THAT row, and the poll below swaps
          // this bubble by the same id. Legacy payloads keep the local id.
          const serverId = typeof data.messageId === 'string' && data.messageId.trim() ? data.messageId : null;
          const appended: CodingMessage = {
            id: serverId ?? `a-${Date.now()}`, role: 'assistant',
            content: data.finalText || '', parts: data.parts || [], createdAt: new Date().toISOString(),
            ...(meta ? { plainMeta: meta } : provenance ? { plainMeta: provenance } : {}),
          };
          setMessages(prev => [...prev, appended]);
          // First answer shipped while the Double Checker was still working:
          // poll the row until the backend clears pendingCrossCheck, then swap
          // the bubble (content/parts/metadata) — "Updated after the Double
          // Checker finished". Stops when the user leaves this chat.
          // Depth UX (2026-09-26): a check still 'checking' at complete polls
          // the same way — the pill flips to Checked / Updated when the row's
          // metadata.check settles (plainRevisionPending covers both flags).
          // ONE poll per row (startPendingRowPoll): a reload that lands on the
          // same pending row never stacks a second poll, and the bound settles
          // the pill to "Check didn't finish" instead of leaving "Checking…"
          // (2026-09-26).
          if (serverId && plainRef.current && sid && (data.pendingCrossCheck === true || plainRevisionPending(meta))) {
            startPendingRowPoll([...messagesRef.current, appended], sid);
          }
          // Guest sessions (63bb607f): mirror the completed turn into the
          // browser-local store. messagesRef holds the latest committed
          // transcript (the echo render already synced it) — never a stale
          // closure over `messages`.
          plainRef.current?.onTranscriptChange?.([...messagesRef.current, appended]);
          // Same handler tick as the append above — React batches both into ONE
          // paint, so the answer swaps from live parts to the message seamlessly.
          setLive(l => ({ ...l, parts: [], workers: undefined, verify: undefined, status: undefined, steps: undefined, check: undefined }));
          // Chatless guests have no plan/session endpoints — skip (C3).
          if (sid) codingApi.getPlan(sid).then(p => { if (activeIdRef.current === sid) setPlan(p); }).catch(() => {});
        }
      } else if (type === 'error') {
        terminal = true;
        finish();
        closeReplayGate();
        // Audit sse-ui-restore-14 (2026-09-26): a Dig-deeper REFUSAL (the
        // controller refused before anything persisted — ESCALATION_BUSY /
        // _EXHAUSTED / DEPTH_BUDGET_EXCEEDED / …) retracts the optimistic
        // "Dig deeper" echo so countSpentEscalations never counts a rung that
        // did not run (the chip used to come back as the NEXT rung, or vanish);
        // a terminal refusal also strips the parent's chip. The server's own
        // sentence is shown calmly — it is not an agent error.
        const refusal = plainRef.current ? escalationRefusalPlan(data) : null;
        const inflight = escalationInFlightRef.current;
        escalationInFlightRef.current = null;
        if (refusal && inflight) setMessages(prev => applyEscalationRefusal(prev, inflight, refusal));
        // 05303f58 (BUG 2): a terminal error re-arrives on every stream replay
        // after a reconnect — toast it ONCE per mount (seq-keyed when the
        // frame carries one, message-keyed otherwise); the first toast stands.
        // Dig-deeper refusals (audit 2026-09-26 sse-ui-restore-3 / -14): the
        // server's structured codes are shown VERBATIM as a calm message (never
        // "Agent error:"); the echo retraction / chip strip happened above
        // (depth-ux-seams.ts applyEscalationRefusal); a quota refusal re-reads
        // the daily quota (lib/depth-ux.ts escalationRefusalFor) and
        // SIGNIN_DEEPER offers the sign-in action.
        const code = typeof data?.code === 'string' ? data.code : '';
        const refusalMeta = ESCALATION_REFUSAL_CODES.has(code) ? escalationRefusalFor(code) : null;
        if (refusal || refusalMeta) {
          const refusalMessage = refusal?.message ?? String(data.message);
          if (shouldToastError(toastedErrorSigsRef.current, errorToastSignature(data, ev.lastEventId || undefined))) {
            if (code === 'SIGNIN_DEEPER') toast.message(refusalMessage, { action: { label: 'Sign in', onClick: () => { window.location.href = '/login'; } } });
            else toast.message(refusalMessage);
          }
          if (refusalMeta?.refreshQuota) plainRef.current?.onDepthRunSettled?.();
        } else if (shouldToastError(toastedErrorSigsRef.current, errorToastSignature(data, ev.lastEventId || undefined))) {
          toast.error(`Agent error: ${data.message}`);
        }
        if (!refusal && !refusalMeta && sendStartedRef.current && (sendStartedRef.current.escalationOf || sendStartedRef.current.mode === 'deep_research')) plainRef.current?.onDepthRunSettled?.();
        setLive(l => ({ ...l, running: false }));
        setRunning(sid, false);
        if (opts?.attach && sid) reloadSession(sid);
      }
    };
    es.onerror = () => {
      finish();
      if (stale() || terminal) return;
      // C3 (ticket 71b1fec6): chatId-less plain sends (guest + signed-in
      // fallback) have no CHAT attach/liveness endpoint. A GUEST with a session
      // id reconnects through its own attach (stream drops 2026-10-20,
      // guest-reconnect.ts — same backoff, slow-phase reconcile against
      // /session/:id/state); the signed-in fallback (no session id) and
      // NEXT_PUBLIC_GUEST_STREAM_RECONNECT_DISABLED=1 keep the dead end: surface
      // the drop and stop. The narrowing return below then keeps every
      // downstream reconnect path real-chat-only.
      if (plainRef.current && sid == null) {
        const gid = guestReconnectSessionId(plainRef.current, sid);
        const guestAttempts = reconnectRef.current.attempts;
        if (!gid) {
          dropTrackerRef.current.drop(streamDropCtx(sid, guestAttempts), 'resend');
          setLive(l => ({ ...l, running: false, status: 'Connection lost — send your message again to retry' }));
          return;
        }
        reconnectRef.current.attempts = guestAttempts + 1;
        dropTrackerRef.current.drop(streamDropCtx(sid, guestAttempts), 'retrying');
        const { slow: guestSlow, delay: guestDelay } = reconnectBackoff(guestAttempts);
        const sameGuest = () => activeIdRef.current === sid && plainRef.current?.guestSessionId === gid;
        setLive(l => ({ ...l, status: guestSlow ? 'Connection lost — retrying…' : 'Reconnecting…' }));
        reconnectRef.current.timer = setTimeout(async () => {
          if (!sameGuest()) return;
          if (guestSlow) {
            // Reconcile first (like a signed-in chat's liveness probe): a
            // definitive "not live" ends the retries and reads the answer the
            // session history holds; an unreadable state keeps retrying.
            const st = await fetchGuestSessionState(gid);
            if (!sameGuest()) return;
            if (st && !st.active) {
              dropTrackerRef.current.resume(streamDropCtx(sid, reconnectRef.current.attempts), 'ended');
              startGuestResume(gid, messagesRef.current, { afterDrop: true });
              return;
            }
          }
          // The attach replays the run's whole buffer — start from empty parts.
          setLive(l => ({ ...l, parts: [], check: undefined, workers: undefined }));
          connectStream(null, '', { attach: true, url: buildGuestAttachUrl(gid) });
        }, guestDelay);
        return;
      }
      if (sid == null) return; // defensive: coding sessions always pass a real id
      const attempts = reconnectRef.current.attempts;
      reconnectRef.current.attempts = attempts + 1;
      dropTrackerRef.current.drop(streamDropCtx(sid, attempts), 'retrying');
      // Fast exponential retries first; then NEVER give up silently — a deploy
      // window (build starving the box + blue/green switch + lock TTL) outlasts
      // any short retry budget, and abandoning the stream left sessions frozen
      // on "Reconnecting…" with the server later ready but nobody re-attaching
      // (prod incident 2026-07-22). In slow mode, reconcile against the server
      // first: if the run actually ended while disconnected, show the persisted
      // answer and stop; only re-attach while it's genuinely still running.
      const { slow, delay } = reconnectBackoff(attempts);
      setLive(l => ({ ...l, status: slow ? 'Connection lost — retrying…' : 'Reconnecting…' }));
      reconnectRef.current.timer = setTimeout(async () => {
        if (activeIdRef.current !== sid) return;
        if (slow) {
          if (plainRef.current) {
            // Plain: no coding session to reconcile against — probe liveness
            // (tri-state): only a definitive FALSE stops the retries (a probe
            // ERROR leaves them running; a blind re-attach for an ended run
            // would loop on the dead attach endpoint). 'gone' (owner
            // 2026-10-27) = the chat row is DELETED — terminal, land in the
            // deleted state instead of looping on a chat that no longer exists.
            const active = await fetchPlainRunActive(sid);
            if (activeIdRef.current !== sid) return;
            if (active === 'gone') {
              dropTrackerRef.current.resume(streamDropCtx(sid, reconnectRef.current.attempts), 'ended');
              markChatDeleted(sid); // terminal — no more re-attach
              return;
            }
            if (active === false) {
              dropTrackerRef.current.resume(streamDropCtx(sid, reconnectRef.current.attempts), 'ended');
              await reloadPlain(sid); // shows the persisted final answer
              if (activeIdRef.current !== sid) return;
              setLive(l => ({ ...l, parts: [], workers: undefined, verify: undefined, status: undefined, steps: undefined, running: false, pendingApproval: null }));
              setRunning(sid, false);
              return;
            }
          } else {
            // Owner 2026-10-27 (stale-delete UI report): a 404 here is the
            // session GET failing — but that means BOTH "chat deleted" AND
            // "live chat, satellite detached" (review round 1, finding 2).
            // CONFIRM via the plain chat read before latching anything
            // terminal; network failures keep the retry loop.
            let gone = false;
            const s = await codingApi.getSession(sid, { messageLimit: CODING_PAGE }).catch((e: any) => {
              if (e?.response?.status === 404) gone = true;
              return null;
            });
            if (activeIdRef.current !== sid) return;
            if (gone) {
              const verdict = await confirmCodingChatGone(sid);
              if (activeIdRef.current !== sid) return;
              dropTrackerRef.current.resume(streamDropCtx(sid, reconnectRef.current.attempts), 'ended');
              if (verdict === 'gone') {
                markChatDeleted(sid); // terminal — no more re-attach
                return;
              }
              if (verdict === 'no_workspace') {
                // Chat alive, satellite detached — the honest no-workspace
                // state (the cold-load arm's own semantics), not "deleted".
                setLive(l => ({ ...l, parts: [], workers: undefined, verify: undefined, status: undefined, steps: undefined, running: false, pendingApproval: null }));
                setRunning(sid, false);
                setLoadFailed('no_workspace');
                return;
              }
              // 'unknown' (confirm probe failed) — fall through: the stream
              // re-attach below is the same retry the old code did.
            }
            if (s && s.status !== 'running') {
              dropTrackerRef.current.resume(streamDropCtx(sid, reconnectRef.current.attempts), 'ended');
              applyFetchedSession(sid, s, { merge: true });
              setLive(l => ({ ...l, parts: [], workers: undefined, verify: undefined, status: undefined, steps: undefined, running: false, pendingApproval: null }));
              setRunning(sid, false);
              codingApi.getPlan(sid).then(p => { if (activeIdRef.current === sid) setPlan(p); }).catch(() => {});
              return;
            }
          }
        }
        // With a resume cursor (0c158104) the server replays only events PAST
        // what we rendered — the parts continue seamlessly, so DON'T wipe them.
        // Without one the whole log replays and appending would duplicate.
        const resumed = !!storedStreamSeq(sid);
        setLive(l => ({ ...l, ...(resumed ? {} : { parts: [], check: undefined }), workers: undefined }));
        // Plain attach URLs carry the 15-min JWT (review M3) — refresh it
        // before connectStream builds the URL (no-op when fresh/anonymous).
        if (plainRef.current) await ensureFreshAuthCookie();
        if (activeIdRef.current !== sid) return;
        connectStream(sid, '', { attach: true });
      }, delay);
    };
    // Host callbacks are read via refs — connectStream stays referentially
    // stable so the session-load effect depends on chatId ALONE. (reloadPlain
    // is a dep because the plain slow-reconnect path calls it; it is itself
    // useCallback([])-stable, so connectStream's identity is unchanged. Same
    // for applyFetchedSession and resetBrowserActivity — useCallback([])-stable.)
  }, [reloadSession, setRunning, noteReplayActivity, reloadPlain, applyFetchedSession, resetBrowserActivity, startPendingRowPoll, startGuestResume, streamDropCtx, markChatDeleted]);

  // Load the session when the chat changes.
  useEffect(() => {
    activeIdRef.current = chatId;
    setQueueItems([]); // ticket ea04454c: the queue panel is per-chat
    setActiveSession(null); setProject(null); setMessages([]); setPlan(null); setLoadFailed(false);
    setLive({ parts: [], pendingApproval: null, running: false });
    resetBrowserActivity(); // browser panel/sheet are chat-scoped (Phase 6a)
    setVisibleCount(MSG_WINDOW);
    setPendingSteerIds(new Set());
    // Provision queue is per session: restore THIS chat's stash (a reload or a
    // chat switch mid-provisioning keeps what the user already sent).
    { const restored = chatId ? loadProvisionQueue(chatId) : []; provisionQueueRef.current = restored; setProvisionQueueState(restored); }
    setPlainPaging({ hasMore: false, cursor: null });
    setCodingPaging({ hasMore: false, cursor: null });
    setPlainLoaded(false);
    setLoadingEarlier(false);
    prependScrollRef.current = null;
    pinnedRef.current = true; capTopRef.current = null; setShowJumpToEnd(false);
    initialAnchorRef.current = true; // anchor pre-paint when the messages land
    replayActiveRef.current = false; // drop replay-gate state from the previous chat
    if (replayTimerRef.current) { clearTimeout(replayTimerRef.current); replayTimerRef.current = null; }
    if (plainRef.current) {
      // Plain mode: no satellite session to fetch — load the plain transcript
      // and attach immediately if the page knows a run is live for this chat.
      // C3 (ticket 71b1fec6): chatId-less plain mode (anonymous guests + the
      // signed-in createChat-failure fallback) — no transcript GET, attach, or
      // liveness probe exists without a chat row. The session starts empty
      // (local state only) and plainLoaded settles IMMEDIATELY so the
      // auto-start may fire the page's hand-off message.
      // 63bb607f: a REOPENED guest session seeds from its browser-local
      // transcript instead of starting empty (a fresh guest chat passes no
      // initialTranscript and behaves exactly as before).
      if (!chatId) {
        const seed = plainRef.current?.initialTranscript ?? [];
        setMessages(seed);
        setPlainPaging({ hasMore: false, cursor: null });
        // Deterministic restore (owner report 2026-09-26): a reopened session
        // NEVER mounts with streaming chrome — nothing is attached in this tab.
        setLive({ parts: [], pendingApproval: null, running: false });
        setPlainLoaded(true);
        // Guest resume (guest-resume.ts): a transcript that ENDS on a user row
        // was reloaded mid-answer. Hydrate the answer the session history holds,
        // or — while the run is still live — show ONE calm "still working" state
        // and poll until it lands. A finished transcript never gets here.
        const gid = plainRef.current?.guestSessionId;
        if (gid && plainRef.current?.guest && guestResumeNeeded(seed)) startGuestResume(gid, seed);
        return;
      }
      void (async () => {
        try {
          // Ticket ce78ab80 — snapshot-first, the plain twin of the coding
          // snapshot above. A re-open of a chat visited minutes ago paints its
          // transcript + queued partition INSTANTLY and revalidates below,
          // instead of showing an empty screen behind this blocking GET. The
          // snapshot is a hint only: the fetch below stays authoritative and
          // replaces the painted rows when it lands. Live/stream state is left
          // to the fetch (this effect already reset it to not-running), so a
          // stale snapshot can never paint streaming chrome.
          const snap = plainTranscriptSnapshots.read(chatId);
          if (snap) {
            setSupervisorChat(snap.supervisorChat);
            setMessages(snap.messages);
            setPendingSteerIds(new Set(snap.pendingIds));
            setPlainPaging(snap.paging);
          }
          const full = await crossModelApi.getChat(chatId, { messageLimit: 50 });
          if (activeIdRef.current !== chatId) return;
          setSupervisorChat(!!(full.isSupervisor || full.isProjectSupervisor));
          // Restored check state (owner report 2026-09-26): a stale 'checking'
          // row settles to "Check didn't finish"; a young one is polled from
          // THIS tab (the original tab's poll died with it). Never a
          // live-stream affordance — the rows render from their metadata.
          const restored = settleRestoredRows(mapPlainMessages(full));
          // Ticket c0b2b0c8 (initial load): the plain GET now also returns
          // pendingMessages — the queue of user messages waiting for the
          // active run to finish. Map them as `pending-*` rows appended at
          // the bottom (the drain appends them chronologically later anyway)
          // and union their ids into pendingSteerIds so they render in the
          // queued partition, indistinguishable from a locally-sent bubble.
          const restoredPending = mapPlainPendingMessages(full);
          setMessages(restoredPending.length ? [...restored, ...restoredPending] : restored);
          setPendingSteerIds(prev => { const next = new Set(prev); for (const m of restoredPending) next.add(m.id); return next; });
          // Ticket ce78ab80 (review MINOR-1): the union above is the c0b2b0c8
          // rule and must stay — it preserves a locally-sent `tmp-*` echo whose
          // drain has not landed yet. But the snapshot paint may ALSO have
          // re-seeded `pending-*` ids that the server drained while this view
          // was unmounted, and those must be RELEASED, or a drained turn
          // renders in the queued slot until the next reload. Prune exactly
          // the snapshot-seeded ids the server no longer lists (never the
          // local echoes, which are not in `snap.pendingIds`).
          if (snap) {
            const listedNow = new Set(restoredPending.map(m => m.id));
            const seeded = new Set(snap.pendingIds);
            setPendingSteerIds(prev => {
              const next = new Set<string>();
              for (const id of prev) if (!(seeded.has(id) && !listedNow.has(id))) next.add(id);
              return next;
            });
          }
          setPlainPaging({ hasMore: !!full.hasMoreMessages, cursor: full.nextMessagesBefore ?? null });
          // Ticket ce78ab80: store the FETCHED page (never the pre-fetch
          // snapshot above) so the next remount paints what the server just
          // confirmed. Written from the same values the view is committing,
          // so cache and screen cannot disagree.
          rememberPlainTranscript(
            chatId,
            restoredPending.length ? [...restored, ...restoredPending] : restored,
            { hasMore: !!full.hasMoreMessages, cursor: full.nextMessagesBefore ?? null },
            restoredPending.map(m => m.id),
            !!(full.isSupervisor || full.isProjectSupervisor),
          );
          startPendingRowPoll(restored, chatId);
          const attach = !!plainRef.current?.attachOnLoad;
          setLive({ parts: [], pendingApproval: null, running: attach });
          // Initial load settled — the plain auto-start (C3 blocker 1) may now
          // fire; if `attach` is true a run is live and the live.running gate
          // holds it off until that run finishes.
          setPlainLoaded(true);
          // Fresh JWT before the attach URL is built (review M3 — 15-min token).
          if (attach) {
            setRunStart(Date.now());
            await ensureFreshAuthCookie();
            if (activeIdRef.current !== chatId) return;
            connectStream(chatId, '', { attach: true });
          } else {
            // Externally-started runs (Telegram / schedule / another device —
            // review M6): the page only knows about runs it started locally,
            // so attachOnLoad misses these. Probe liveness once on open and
            // attach on a definitive TRUE (tri-state: null/false both skip).
            void (async () => {
              const active = await fetchPlainRunActive(chatId);
              if (active !== true || activeIdRef.current !== chatId || esRef.current) return;
              reconnectRef.current.attempts = 0;
              setLive(l => ({ ...l, parts: [], workers: undefined, running: true, check: undefined, steps: undefined }));
              setRunStart(rs => rs ?? Date.now());
              setRunning(chatId, true);
              connectStream(chatId, '', { attach: true });
            })();
          }
        } catch (e: any) {
          // Owner 2026-10-27 (stale-delete UI report): 404 = the chat row is
          // GONE (deleted) — terminal deleted copy, not the retryable error
          // state (a retry would just 404 again). Anything else stays 'error'.
          if (activeIdRef.current === chatId) setLoadFailed(e?.response?.status === 404 ? 'deleted' : 'error');
        }
      })();
      return;
    }
    // Coding path below — chatId is always real here (plain chatless returned
    // above; coding mounts always pass an id). The guard narrows the type.
    if (!chatId) return;
    void (async () => {
      // Snapshot-first (2026-08-31 session-open perf): a remount minutes after
      // the last visit renders the cached transcript + session chrome INSTANTLY
      // and revalidates below — no "Opening session" spinner, no waiting on the
      // transcript round-trip. The module-level snapshot survives the
      // key={chatId} remount; 15-min TTL.
      const snap = readSessionSnapshot(chatId);
      if (snap) {
        setActiveSession(snap.session);
        if (snap.project) setProject(snap.project);
        if (snap.sessionUsage && (snap.sessionUsage.inTokens || snap.sessionUsage.outTokens)) setSessionUsage(snap.sessionUsage);
        setMessages(snap.messages);
        setCodingPaging(snap.paging);
        const snapRunning = snap.session.status === 'running';
        setLive({ parts: [], pendingApproval: null, running: snapRunning });
        if (snapRunning) setRunStart(Date.now());
      }
      let full: Awaited<ReturnType<typeof codingApi.getSession>>;
      try {
        full = await codingApi.getSession(chatId, { messageLimit: CODING_PAGE });
      } catch (e: any) {
        // With a snapshot on screen a transient failure just leaves the stale
        // view up (the next resync retries) — only a cold open hard-fails.
        // A 404 here means BOTH "no ChatCodingState satellite" (the honest
        // no_workspace copy) AND "the chat itself is gone/revoked" (owner
        // 2026-10-27 stale-delete report: a stale sidebar row opened after a
        // missed chat.deleted push). The session GET cannot split them —
        // confirm via the plain chat read (review round 2, defect 1):
        // getChat 404 ⇒ deleted ⇒ the terminal 'deleted' state; getChat 200
        // ⇒ satellite-less ⇒ the no_workspace arm as before; anything else is
        // a real load failure and keeps the retryable error state (P4).
        if (activeIdRef.current === chatId && !snap) {
          if (e?.response?.status !== 404) { setLoadFailed('error'); return; }
          const verdict = await confirmCodingChatGone(chatId);
          if (activeIdRef.current !== chatId) return;
          setLoadFailed(verdict === 'gone' ? 'deleted' : verdict === 'no_workspace' ? 'no_workspace' : 'error');
        }
        return;
      }
      if (activeIdRef.current !== chatId) return;
      const running = full.status === 'running';
      applyFetchedSession(chatId, full, { merge: true });
      // The parts are zeroed for this open/switch — a cursor resume would
      // rebuild only the TAIL of an in-flight turn (0c158104 review F2): drop
      // any stored cursor so the attach below (and later resyncs AFTER a
      // switch) start from the full replay. Refocus/reconnects while STAYING
      // on the chat keep their cursor (this effect only fires on chatId change).
      clearStreamSeq(chatId);
      setLive({ parts: [], pendingApproval: null, running });
      if (running) setRunStart(Date.now());
      codingApi.getPlan(chatId).then(p => { if (activeIdRef.current === chatId) setPlan(p); }).catch(() => setPlan(null));
      if (running) connectStream(chatId, '', { attach: true });
    })();
  }, [chatId, loadNonce, connectStream, setRunning, applyFetchedSession, resetBrowserActivity, startPendingRowPoll, startGuestResume]);

  // Re-sync when the tab/app regains focus. A long run's SSE stream dies while
  // the tab is backgrounded or the machine sleeps (browsers suspend EventSource
  // and throttle the reconnect timers), and because chatId hasn't changed the
  // load effect above never re-fires — so on return the transcript is frozen at
  // wherever it was when we left. A page reload only "fixes" it because it
  // re-fetches. Instead, reconcile against the server on visibility/focus: pull
  // the latest session and either show the final answer (run ended while away) or
  // re-attach the stream (still running but our connection is dead).
  const resyncActive = useCallback(async () => {
    const sid = activeIdRef.current;
    if (!sid) {
      // Guests (stream drops 2026-10-20, guest-reconnect.ts): no chat row, but a
      // session id — reconcile against GET /session/:id/state. Only while an
      // answer is outstanding (the transcript ends on the guest's question) and
      // no stream is flowing; never on top of the reload resume's own poll.
      // NEXT_PUBLIC_GUEST_STREAM_RECONNECT_DISABLED=1 ⇒ guestReconnectSessionId
      // is null ⇒ the old early return.
      const gid = guestReconnectSessionId(plainRef.current, sid);
      if (!gid) return;
      if (Date.now() - lastResyncRef.current < 1500) return; // focus + visibilitychange both fire
      if (!guestResumeNeeded(messagesRef.current) || guestResumeRef.current) return;
      // A send's first seconds own the stream (the URL build is async — there
      // may be no EventSource yet); its own onerror covers a drop there.
      if (sendStartedRef.current && Date.now() - sendStartedRef.current.at < 10_000) return;
      const es0 = esRef.current;
      if (es0 && es0.readyState !== 2) return; // OPEN/CONNECTING — events are flowing
      lastResyncRef.current = Date.now();
      const st = await fetchGuestSessionState(gid);
      if (activeIdRef.current !== sid || plainRef.current?.guestSessionId !== gid) return;
      if (!st) return; // UNKNOWN — leave the state alone (as the signed-in null probe)
      const es1 = esRef.current;
      if (es1 && es1.readyState !== 2) return; // something re-attached while we asked
      if (st.active) {
        reconnectRef.current.attempts = 0;
        setLive(l => ({ ...l, parts: [], workers: undefined, running: true, check: undefined, steps: undefined }));
        connectStream(null, '', { attach: true, url: buildGuestAttachUrl(gid) });
      } else {
        // Run ended while away: hydrate the answer the session history holds.
        // Only a tab that SAW its stream drop says "didn't finish" when there is
        // none (a plain refocus on an old unanswered question stays quiet).
        const afterDrop = dropTrackerRef.current.episodeOpen;
        dropTrackerRef.current.resume(streamDropCtx(sid, reconnectRef.current.attempts), 'ended');
        startGuestResume(gid, messagesRef.current, { afterDrop });
      }
      return;
    }
    // Plain mode (P2 increment 2): reconcile = reload the transcript, THEN use
    // the liveness signal to re-attach a dead stream mid-run (the SSE dies
    // while backgrounded — browsers suspend EventSource) or drop stale live
    // state when the run finished while we were away.
    if (plainRef.current) {
      if (Date.now() - lastResyncRef.current < 1500) return; // focus + visibilitychange both fire
      lastResyncRef.current = Date.now();
      await reloadPlain(sid);
      const es = esRef.current;
      if (es && es.readyState !== 2) return; // OPEN/CONNECTING — events are flowing
      const active = await fetchPlainRunActive(sid); // tri-state (refreshes the JWT first)
      if (activeIdRef.current !== sid) return;
      if (active === 'gone') {
        // Owner 2026-10-27: the chat row is gone (deleted elsewhere while this
        // tab was away) — terminal, land in the deleted state.
        markChatDeleted(sid);
        return;
      }
      if (active === true) {
        reconnectRef.current.attempts = 0;
        setLive(l => ({ ...l, parts: [], workers: undefined, running: true, check: undefined, steps: undefined }));
        setRunStart(rs => rs ?? Date.now());
        setRunning(sid, true);
        connectStream(sid, '', { attach: true });
      } else if (active === false) {
        // Run ended while away — the reloaded transcript shows the final
        // answer; any live parts still on screen would duplicate it.
        setLive(l => (l.running || l.parts.length ? { parts: [], pendingApproval: null, running: false } : l));
        setRunning(sid, false);
      }
      // null = UNKNOWN (transient failure) — leave state untouched: clearing
      // would kill a live run's dot, attaching blind could hit a dead endpoint.
      return;
    }
    if (Date.now() - lastResyncRef.current < 1500) return; // focus + visibilitychange both fire
    lastResyncRef.current = Date.now();
    let full: Awaited<ReturnType<typeof codingApi.getSession>>;
    try { full = await codingApi.getSession(sid, { messageLimit: CODING_PAGE }); } catch (e: any) {
      // Owner 2026-10-27: 404 needs the same confirm-probe as the reconnect
      // path (deleted vs satellite-detached are indistinguishable on the
      // session GET — review round 1, finding 2); transient failures stay
      // non-terminal. The beacon pairing the reconnect path has (finding 10).
      if (e?.response?.status === 404) {
        const verdict = await confirmCodingChatGone(sid);
        if (activeIdRef.current !== sid) return;
        dropTrackerRef.current.resume(streamDropCtx(sid, reconnectRef.current.attempts), 'ended');
        if (verdict === 'gone') markChatDeleted(sid);
        else if (verdict === 'no_workspace') setLoadFailed('no_workspace');
      }
      return;
    }
    if (activeIdRef.current !== sid) return;
    if (full.status !== 'running') {
      // Run finished/errored while we were away — drop the stale live state and
      // show the persisted final messages (we never received the 'complete' event).
      const es = esRef.current; esRef.current = null; es?.close();
      if (reconnectRef.current.timer) { clearTimeout(reconnectRef.current.timer); reconnectRef.current.timer = null; }
      applyFetchedSession(sid, full, { merge: true });
      setLive(l => ({ ...l, parts: [], workers: undefined, verify: undefined, status: undefined, steps: undefined, running: false, pendingApproval: null }));
      setRunning(sid, false);
      codingApi.getPlan(sid).then(p => { if (activeIdRef.current === sid) setPlan(p); }).catch(() => {});
      return;
    }
    // Still running: re-attach only if our stream is actually dead (CLOSED or
    // gone). A live OPEN/CONNECTING stream is already delivering events — leave it
    // so a quick tab-switch doesn't clear-and-replay the transcript (flicker).
    const es = esRef.current;
    if (!es || es.readyState === 2) {
      reconnectRef.current.attempts = 0;
      // Resume cursor present (0c158104): the replay is only the events we
      // missed — keep the rendered parts (no clear-and-replay flicker).
      const resumed = !!storedStreamSeq(sid);
      setLive(l => ({ ...l, ...(resumed ? {} : { parts: [], check: undefined }), workers: undefined, running: true }));
      connectStream(sid, '', { attach: true });
    }
  }, [connectStream, setRunning, reloadPlain, applyFetchedSession, startGuestResume, streamDropCtx]);

  useEffect(() => {
    const onFocus = () => { void resyncActive(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void resyncActive(); };
    // Network back (stream drops 2026-10-20): a Wi-Fi hand-off / a phone leaving
    // a dead zone fires 'online' with the tab still focused — reconcile at once
    // instead of waiting out a 15 s slow-phase retry. resyncActive's own guards
    // (1.5 s dedupe, a flowing stream is left alone) apply.
    // NEXT_PUBLIC_ONLINE_RESYNC_DISABLED=1 ⇒ no listener.
    const onOnline = () => { void resyncActive(); };
    const listenOnline = !onlineResyncDisabled();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    if (listenOnline) window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      if (listenOnline) window.removeEventListener('online', onOnline);
    };
  }, [resyncActive]);

  // Autoscroll only when pinned to the bottom. Worker/verify chips, status
  // lines, and the approval card also grow the transcript — missing them here
  // let content pile up unscrolled, then SNAP on the next text delta.
  // The newest turn's anchor row in scroller coordinates (rows carry
  // data-row-role; lib/transcript-pin turnAnchorIndex picks the row).
  const readTurnAnchor = useCallback((): { key: string; top: number; height: number } | null => {
    const scroller = scrollRef.current;
    const content = transcriptContentRef.current;
    if (!scroller || !content) return null;
    const rows = Array.from(content.querySelectorAll<HTMLElement>('[data-row-role]'));
    const i = turnAnchorIndex(rows.map(r => r.dataset.rowRole || ''));
    if (i < 0) return null;
    const row = rows[i];
    const sr = scroller.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    return { key: row.dataset.msgId || `row-${i}`, top: rr.top - sr.top + scroller.scrollTop, height: rr.height };
  }, []);
  // Pinned follow: down to the bottom, or — for a turn that arrived while the
  // reader watched — down to that turn's start and no further. Never scrolls
  // UP (a reader is never yanked back), so the stop line holds when the reply
  // keeps growing and when the run completes.
  const followLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el || replayActiveRef.current || !pinnedRef.current) return;
    const anchor = readTurnAnchor();
    const t = followTarget(el, anchor && capOffKeyRef.current !== anchor.key ? anchor : null);
    capTopRef.current = t.capped ? t.top : null;
    if (t.top > el.scrollTop + 1) el.scrollTo({ top: t.top });
    if (t.capped) setShowJumpToEnd(el.scrollHeight - el.clientHeight - t.top > NEAR_BOTTOM_PX);
  }, [readTurnAnchor]);
  followLatestRef.current = followLatest;
  /** Opt the current turn into full follow (Jump to latest, scrolled-to-bottom, chat-open landing). */
  const releaseTurnAnchor = useCallback(() => {
    const a = readTurnAnchor();
    capOffKeyRef.current = a ? a.key : null;
    capTopRef.current = null;
  }, [readTurnAnchor]);

  useEffect(() => {
    if (replayActiveRef.current) return; // attach replay in flight — one landing scroll when it drains
    followLatest();
  }, [messages, live.parts, live.running, live.workers, live.verify, live.status, live.pendingApproval, followLatest]);

  // Pre-paint initial anchor (armed by the chat-change load effect): land at
  // the latest message before the first painted frame, so opening a long chat
  // never visibly scrolls through already-read history.
  useLayoutEffect(() => {
    if (!initialAnchorRef.current || messages.length === 0) return;
    initialAnchorRef.current = false;
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
    // Opening a chat lands at the bottom of what is already there — the turn
    // anchor applies to turns that arrive while the reader is watching (a new
    // chat's first send also lands here: keep that turn anchored).
    if (Date.now() - sentAtRef.current > 10_000) releaseTurnAnchor();
  }, [messages, releaseTurnAnchor]);

  // "Load earlier" prepend restore (plain paging, review H2): keep the
  // viewport anchored to the message the reader was on by offsetting the
  // saved scrollTop by however much taller the prepended page made the
  // content. One-shot: armed synchronously with the prepend commit.
  useLayoutEffect(() => {
    const snap = prependScrollRef.current;
    if (!snap) return;
    prependScrollRef.current = null;
    const el = scrollRef.current;
    if (el) el.scrollTop = snap.top + (el.scrollHeight - snap.height);
  }, [messages]);

  // Stay glued to the latest through ANY size change: async content growth
  // (markdown render, syntax highlighting, images loading in after the state
  // effect above already ran) and container resizes (keyboard, panel,
  // orientation). This was the "keep clicking Jump to latest after reopening"
  // bug: the state effect fired once on load, then post-paint growth stranded
  // the view mid-transcript. Instant scrolls, and only while pinned — never
  // yank the user down when they scrolled up to read.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = transcriptContentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return;
    const stick = () => followLatestRef.current();
    const ro = new ResizeObserver(stick);
    ro.observe(content);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, []);

  // Pin discipline lives in lib/transcript-pin.ts (pure, unit-tested; shared
  // with the supervisor thread). Owner recording 2026-09-18: the old inline
  // rule re-pinned on every event inside the 80px near-bottom band BEFORE
  // testing for an upward move, so a slow wheel/trackpad scroll-up during a
  // stream was yanked back to the bottom by the next chunk or the 1s elapsed-
  // clock re-render — "it won't let you scroll up". An upward move now unpins
  // at once (with a short gesture window so momentum/anchoring bumps can't
  // re-pin); only landing at/near the bottom re-pins. Downward moves far from
  // the bottom (Chrome scroll-anchoring bumps, programmatic scrolls — the
  // "keep clicking Jump to latest" loop) still never change the pin.
  const onTranscriptScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { next, showJump } = decideTranscriptPin(
      { pinned: pinnedRef.current, lastTop: lastScrollTopRef.current, upGestureUntil: upGestureUntilRef.current },
      { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, now: Date.now() },
    );
    let pinned = next.pinned;
    let jump = showJump;
    // Turn anchor: our own follow never scrolls past the stop line, so a
    // position BELOW it is the reader's — at the bottom they want full follow
    // for this turn; anywhere else they are reading inside the reply, so stop
    // moving the view.
    const capTop = capTopRef.current;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (capTop != null && el.scrollTop > capTop + 2) {
      if (pinned && dist < NEAR_BOTTOM_PX) releaseTurnAnchor();
      else { pinned = false; jump = true; }
    } else if (capTop != null && pinned) {
      jump = dist > NEAR_BOTTOM_PX; // parked at the stop line with more reply below
    }
    pinnedRef.current = pinned;
    lastScrollTopRef.current = next.lastTop;
    upGestureUntilRef.current = next.upGestureUntil;
    setShowJumpToEnd(jump);
  }, [releaseTurnAnchor]);
  const jumpToEnd = useCallback(() => {
    pinnedRef.current = true;
    releaseTurnAnchor();
    setShowJumpToEnd(false);
    // Instant, not smooth: a smooth scroll loses the race against a live stream
    // — mid-flight scroll events mark us unpinned, the next delta grows the
    // transcript, and the pill reappears (the "click over and over" loop).
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [releaseTurnAnchor]);

  // Poll a provisioning session until ready. usePolling (P5): abortable ticks,
  // `key` restarts the poll when the session changes, `enabled` stops it the
  // moment the status flips. Always-on (pauseWhenHidden:false) — readiness
  // gates the auto-start send below, so a user who tabs away during
  // provisioning must still get their run started.
  const provisioningId = activeSession?.status === 'provisioning' ? activeSession.id : null;
  usePolling(
    async (signal) => {
      if (!provisioningId) return;
      const s = await codingApi.getSession(provisioningId, { signal }).catch(() => null);
      if (signal.aborted || activeIdRef.current !== provisioningId) return;
      if (s && s.status !== 'provisioning') setActiveSession(s);
    },
    { intervalMs: 3000, enabled: !!provisioningId, key: provisioningId, immediate: false, pauseWhenHidden: false },
  );

  // Coding patience level: auto-start the run for the message that created this
  // session, once the worktree is ready. Consumed exactly once (ref guard covers
  // StrictMode double-effects; host clears its copy via onInitialMessageConsumed).
  // C3 blocker 1 (ticket 71b1fec6): plain chats have NO coding satellite —
  // activeSession stays null forever — so the ready gate is replaced by the
  // plain-load settle flag: fire once the initial transcript GET lands and no
  // run is live. '' is a REAL pending send in plain mode (attachment-only
  // home-screen hand-off: the staged bar rides plain.takeAttachments and
  // send() builds the server placeholder), hence the == null check.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (initialMessage == null || autoStartedRef.current) return;
    if (plain) {
      if (!plainLoaded || live.running) return;
    } else if (!initialMessage || !activeSession || activeSession.status !== 'ready' || live.running) {
      return;
    }
    autoStartedRef.current = true;
    onInitialMessageConsumed?.(chatId);
    // Anything the user sent while the session provisioned rides THIS first
    // run (the session has one run slot — a second send would 409 busy).
    const queuedBehind = plain ? [] : provisionQueueRef.current;
    if (queuedBehind.length) {
      const merged = mergeQueued(queuedBehind);
      setProvisionQueue(chatId, []);
      void send(
        mergeIntoInitial(initialMessage, queuedBehind),
        [...(initialImages ?? []), ...merged.images],
        { overrideUploads: merged.uploads as unknown as AttachmentInfo[] },
      );
      return;
    }
    void send(
      initialMessage,
      initialImages?.length ? initialImages : undefined,
      initialDisplayContent != null ? { displayContent: initialDisplayContent } : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.status, initialMessage, live.running, plainLoaded]);

  // Drain the send-while-provisioning queue once the session is ready and
  // idle (lib/provision-queue.ts drainAction). A pending auto-start message
  // carries the queue itself (above), so this only fires for a session the
  // user opened and typed into before its worktree finished provisioning.
  useEffect(() => {
    if (plain || !activeSession || activeSession.id !== chatId) return;
    const queued = provisionQueueRef.current;
    const action = drainAction({
      queued: queued.length,
      sessionStatus: activeSession.status,
      liveRunning: live.running,
      initialPending: !!initialMessage && !autoStartedRef.current,
    });
    if (action !== 'send') return;
    const merged = mergeQueued(queued);
    setProvisionQueue(chatId, []);
    void send(merged.message, merged.images, { overrideUploads: merged.uploads as unknown as AttachmentInfo[] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession?.status, activeSession?.id, live.running, provisionQueue.length, initialMessage, plain]);

  // Drain the GUEST send-while-running queue (d0777a67) the moment the live
  // run ends: one fresh chatless send with everything merged. The queue only
  // ever holds guest mid-run sends, so this fires for a chatless guest mount
  // (plain + guest + !chatId); a run that never ends holds the queue — exactly
  // what the queued bubbles promise ("sends when this answer finishes").
  // N1 (review): the drain is GATED on the server-side run state — a guest
  // Stop closes only this tab's stream (the server run keeps going, and the
  // controller answers a chatless busy send with a terminal error, losing the
  // merged text). fetchGuestSessionState().active === false must agree before
  // the send; an unreadable state (null) fails OPEN (send anyway — the queue
  // must not wedge on a flaky endpoint). Bounded ~5 min of quiet retries; on
  // give-up the queue simply stays staged (never dropped — it re-drains on
  // the next run-end trigger).
  useEffect(() => {
    if (!plain || !plainRef.current?.guest || chatId) return;
    const action = guestDrainAction({ queued: guestQueueRef.current.length, liveRunning: live.running });
    if (action !== 'send') return;
    const gid = plainRef.current.guestSessionId;
    let cancelled = false;
    const drainNow = () => {
      if (cancelled || !guestQueueRef.current.length) return;
      const merged = mergeGuestQueued(guestQueueRef.current);
      setGuestQueue([]);
      // Ticket 625773b5: the held chips ride the drain send (overrideUploads)
      // — the bar was snapshotted at hold time, so takeAttachments is empty
      // now and the ids only survive on the queue rows.
      void send(merged.message, undefined, { overrideUploads: merged.uploads as unknown as AttachmentInfo[] });
    };
    if (!gid) { drainNow(); return; }
    void (async () => {
      for (let attempt = 0; attempt < 60 && !cancelled; attempt++) {
        if (attempt > 0) await new Promise<void>(r => setTimeout(r, 5000));
        if (cancelled) return;
        const st = await fetchGuestSessionState(gid);
        if (cancelled) return;
        if (!st || !st.active) { drainNow(); return; }
        // The server-side run is still live (a Stop ended only this tab's
        // stream) — hold the queue; the promise is "when this answer finishes".
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.running, guestQueue.length, plain, chatId]);

  // ── Actions ──
  // Stable identities (empty deps, session via ref): these are pushed to the
  // host page's floating ⋯ menu through onChromeChange — plain inline functions
  // would change every render and loop the chrome effect.
  const setMode = useCallback(async (mode: PermissionMode) => {
    const sess = activeSessionRef.current;
    if (!sess) return;
    setActiveSession({ ...sess, permissionMode: mode });
    try { await codingApi.updateSession(sess.id, { permissionMode: mode }); } catch {}
  }, []);

  const doPush = useCallback(async () => {
    const sess = activeSessionRef.current;
    if (!sess) return;
    setPublishing('push');
    try { const r = await codingApi.push(sess.id); r.success ? toast.success(r.message) : toast.error(r.message || 'Push failed'); }
    catch { toast.error('Push failed'); } finally { setPublishing(null); }
  }, []);
  const doPr = useCallback(async () => {
    const sess = activeSessionRef.current;
    if (!sess) return;
    setPublishing('pr');
    try { const r = await codingApi.openPr(sess.id, sess.title); r.success ? toast.success(r.message) : toast.error(r.message || 'PR failed'); }
    catch { toast.error('Could not open PR'); } finally { setPublishing(null); }
  }, []);
  // ── Floating chrome hoist ──
  // The session header bar was removed (2026-07-19 UI chrome redesign): branch,
  // model, provisioning status, Push/PR and agent mode now live in the host
  // page's floating ⋯ menu. Assemble that state here and push it up; cleared on
  // unmount (session switch / back to chat). The panel toggle is NOT here — the
  // right panel is the page-owned Side panel checkbox (controlled panelOpen).
  const chrome = useMemo<CodingChrome | null>(() => {
    if (!activeSession) return null;
    return {
      branch: activeSession.branch,
      model: activeSession.model,
      status: activeSession.status,
      errorMessage: activeSession.errorMessage ?? null,
      permissionMode: activeSession.permissionMode,
      publishing,
      projectId: project?.id ?? null,
      actions: { push: doPush, openPr: doPr, setPermissionMode: setMode },
    };
  }, [activeSession, publishing, project?.id, doPush, doPr, setMode]);
  useEffect(() => { onChromeChangeRef.current?.(chrome); }, [chrome]);
  useEffect(() => () => onChromeChangeRef.current?.(null), []);

  // Hide-thinking toggle (ticket 0b4575dd): interleaved-thinking models fill
  // the live transcript with thought rows; this collapses every reasoning
  // row/chip and joins the surrounding prose (AssistantParts groups around
  // thoughts either way). View-layer only. These hooks MUST stay here, above
  // the loadFailed/activeSession early returns below — the 2026-08-28
  // rules-of-hooks regression: this state was declared next to plainSizes,
  // after those returns, so hook order varied between renders (caught by
  // react-hooks/rules-of-hooks lint, which the pre-merge checks had skipped).
  const [hideThinking, setHideThinking] = useState(false);
  // Minimal view (owner 2026-10-16, lib/view-mode.ts): users — and an admin with Debug mode off — see the Grok-style
  // view. The server already withholds the machinery; this picks the minimal layout for what remains.
  const minimal = useMinimalView();
  // Split memos (2026-08-31): with one combined [messages, live.parts] memo,
  // every live-stream frame (new parts identity) re-scanned the WHOLE loaded
  // history for a reasoning part. Now the history scan only re-runs when the
  // transcript itself changes; live frames scan just the live parts.
  const hasHistoryReasoning = useMemo(
    () => messages.some(m => m.parts?.some(p => p.type === 'reasoning')),
    [messages],
  );
  const hasLiveReasoning = useMemo(
    () => live.parts.some(p => p.type === 'reasoning'),
    [live.parts],
  );
  const hasAnyReasoning = hasHistoryReasoning || hasLiveReasoning;

  // Queued-echo partition (ticket 08d31b1a): pending steer/queue echoes are
  // pulled OUT of the persisted history here and rendered in-flow AFTER the
  // live run block below — the messages array stays the chronological
  // record, the render position is where the user's attention is. Empty
  // pending set → identity (history IS messages order).
  // dedupById (P2 item 5): the render-side id-safety — the same message id
  // must never render twice (React key collision + a duplicated bubble),
  // whatever merge/attach race produced it. Distinct-id rows always pass.
  // Steer interleave (owner report 2026-09-09 — "queued messages don't appear
  // in chronological order once the run finishes"): a coding run is ONE
  // assistant row created at run START, so after reload every steer sent
  // during it sorted BELOW the final answer. lib/steer-interleave.ts splits
  // the row at each steer's send time (parts carry backend `ts`) so history
  // reads as it happened live. Coding sessions only: a PLAIN chat's mid-run
  // message is a queued NEXT turn with its own reply, already in order.
  // Send-while-provisioning echoes render in the queued slot (never in
  // `messages`: a session reload replaces that array wholesale).
  const provisionEchoes = useMemo<CodingMessage[]>(() => provisionQueue.map(q => ({
    id: q.id,
    role: 'user' as const,
    content: q.message,
    createdAt: q.createdAt,
    ...(q.images.length ? { parts: [...(q.message ? [{ type: 'text' as const, text: q.message }] : []), ...q.images.map(i => ({ type: 'image' as const, ...i }))] as CodingMessage['parts'] } : {}),
    ...(q.uploads.length ? { plainMeta: { attachments: q.uploads.map(u => ({ filename: u.filename ?? 'file', type: u.type ?? 'document', localPreview: u.localPreview })) } } : {}),
  })), [provisionQueue]);
  // Guest send-while-running echoes (d0777a67) render in the same queued slot
  // — never in `messages`: the drain fires one fresh send whose echo replaces
  // the queued rows (and a guest session reload replaces the array wholesale).
  const guestEchoes = useMemo<CodingMessage[]>(() => guestQueue.map(q => ({
    id: q.id,
    role: 'user' as const,
    content: q.message,
    createdAt: q.createdAt,
    // Ticket 625773b5: a held send's staged chips render on its queued bubble
    // (the same plainMeta.attachments contract a live send's echo uses), so an
    // attachment-only hold is visibly real rather than a blank "Queued" row.
    ...(q.uploads?.length ? { plainMeta: { attachments: q.uploads.map(u => ({ filename: u.filename ?? 'file', type: u.type ?? 'document', localPreview: u.localPreview })) } } : {}),
  })), [guestQueue]);
  const { history, queuedEchoes: steerEchoes } = useMemo(() => {
    const parted = partitionQueuedEchoes(dedupById(minimal ? messages.filter(m => !isMinimalHidden(m.plainMeta)) : messages), pendingSteerIds);
    return plain ? parted : { ...parted, history: interleaveSteers(parted.history) };
  }, [messages, pendingSteerIds, plain, minimal]);
  // Steer / busy-queue echoes first, then anything waiting on provisioning,
  // then guest mid-run holds (d0777a67).
  const queuedEchoes = useMemo(() => {
    const out = [...steerEchoes, ...provisionEchoes, ...guestEchoes];
    return out.length ? out : steerEchoes;
  }, [steerEchoes, provisionEchoes, guestEchoes]);

  // Scroll-up auto-load (2026-09-23) — lives below `history` (TDZ). See the
  // sentinel in the transcript for the UX rationale.
  loadEarlierRef.current = () => {
    if (loadingEarlier) return;
    if (history.length > visibleCount) {
      const el = scrollRef.current;
      pinnedRef.current = false;
      prependScrollRef.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
      setVisibleCount(c => Math.min(c + MSG_WINDOW, MAX_VISIBLE));
    } else if (plain) void loadEarlierPlain();
    else void loadEarlierCoding();
  };
  const canLoadEarlier = history.length > visibleCount || plainPaging.hasMore || codingPaging.hasMore;
  useEffect(() => {
    const root = scrollRef.current;
    const target = topSentinelRef.current;
    if (!root || !target || !canLoadEarlier || visibleCount >= MAX_VISIBLE) return;
    if (typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some(e => e.isIntersecting)) return;
      // Only on a deliberate scroll UP: pinned-at-bottom means the sentinel
      // is visible because the transcript is SHORT, not because the reader
      // went looking for history.
      if (pinnedRef.current) return;
      const now = Date.now();
      if (now < earlierCooldownRef.current) return;
      earlierCooldownRef.current = now + 600;
      loadEarlierRef.current();
    }, { root, rootMargin: '400px 0px 0px 0px', threshold: 0 });
    io.observe(target);
    return () => io.disconnect();
    // Re-arm when the sentinel's reason to exist changes (more to load or not).
  }, [canLoadEarlier, visibleCount, loadingEarlier, plainPaging.hasMore, codingPaging.hasMore, activeSession?.id]);

  // Busy-queue passthrough (P2 increment 2): hand a message to the server's
  // pending queue while a turn is live. connectStream would CLOSE the live
  // stream, so the queue request rides a THROWAWAY EventSource that only
  // listens for the server's `queued` ack (it persists the message, drains it
  // automatically when the turn finishes, and ends this connection).
  const queuePlainBehindLive = async (sid: string, message: string, plainCfg: PlainSessionProps, uploadIds: string[], opts?: { onQueued?: (info: { pendingId: string | null; position: number | null }) => void }) => {
    let url: string;
    try {
      url = await buildPlainStreamUrl({ chatId: sid, message, mode: plainCfg.mode, modeSource: plainCfg.modeSource, webSearch: plainCfg.webSearch, uploadIds });
    } catch {
      toast.error('Could not queue the message.');
      return;
    }
    if (activeIdRef.current !== sid) return;
    const qes = new EventSource(url);
    plainQueueEsRef.current?.close();
    plainQueueEsRef.current = qes;
    const done = () => { qes.close(); if (plainQueueEsRef.current === qes) plainQueueEsRef.current = null; };
    qes.onmessage = (ev) => {
      let msg: any; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'queued') {
        const pos = typeof msg.data?.position === 'number' ? msg.data.position : null;
        // Ticket ea04454c: carry the ROW id back to the caller so "Send now"
        // can promote exactly this message, and refresh the visible queue so the
        // panel shows the true position immediately.
        const pendingId = typeof msg.data?.id === 'string' ? msg.data.id : null;
        toast.message('Message queued', {
          description: pos
            ? `This chat is busy — your message is saved and runs automatically (queue position ${pos}).`
            : 'This chat is busy — your message is saved and runs automatically when the current turn finishes.',
        });
        opts?.onQueued?.({ pendingId, position: pos });
        done();
      } else if (msg.type === 'error') {
        toast.error(`Could not queue the message: ${msg.data?.message || 'unknown error'}`);
        done();
      } else {
        // Any other event means the previous turn ended in the race window and
        // the server started THIS message's run on the throwaway connection —
        // close it (review M2: otherwise it duplicates the whole run's events
        // to a dead consumer for minutes); the post-complete drain check
        // attaches the view properly.
        done();
      }
    };
    qes.onerror = done;
  };

  const send = async (overrideMessage?: string, overrideImages?: ChatImage[], opts?: { bypassRunningGuard?: boolean; displayContent?: string; escalationOf?: string; overrideUploads?: AttachmentInfo[]; interrupt?: boolean }) => {
    const message = (overrideMessage ?? composerRef.current?.getValue() ?? '').trim();
    const plainCfg = plainRef.current;
    if (plainCfg) {
      // Depth UX "Dig deeper" (2026-09-26, lib/depth-ux.ts): an escalation
      // re-sends the chat with escalationOf=<assistantMessageId> and a FIXED
      // label as the message text — the server runs the next rung not yet
      // spent on that message. Signed-in chatId-bound sends only (guests get
      // the sign-in affordance, never the param); never while a turn streams
      // (the chip is disabled then — the queue would just echo the label).
      const escalationOf = opts?.escalationOf && chatId && !plainCfg.guest ? opts.escalationOf : undefined;
      if (opts?.escalationOf && !escalationOf) return;
      if (escalationOf && live.running) { toast.message('Wait for this answer to finish, then dig deeper.'); return; }
      // Plain mode: send rides the legacy chat SSE (GET /crossmodel/stream);
      // the response stream is normalized into coding events on arrival.
      // Busy + attachments (ac65d51e): the server busy-queue now persists the
      // staged uploadIds with the message (pending_chat_messages.uploadIds) —
      // queueing no longer drops files: the chips ride the echo bubble and the
      // drain resolves the blobs when the queued turn runs.
      // Snapshot + clear the page's attachment bar NOW (legacy send semantics:
      // takeAttachments returns the staged uploads and empties the bar).
      // C3 (ticket 71b1fec6): chatId-less sends (guest + fallback) have NO
      // server busy-queue — block mid-run sends BEFORE the bar/composer is
      // touched so nothing the user staged is lost. The composer's canSubmit
      // gate mirrors this (submitTitle 'Wait for this answer…').
      // d0777a67: GUEST mid-run sends are no longer dropped — the send is
      // HELD in the guest queue (echoed as a queued bubble; nothing the user
      // staged is lost, same C3 contract) and drains as one merged send when
      // the run ends. The signed-in fallback keeps the old hold.
      if (live.running && !chatId) {
        // N2 (d0777a67 review): never stage an empty/whitespace draft — a
        // phantom queued bubble. Ticket 625773b5: guests HAVE an attachment
        // bar now, so the bar is snapshotted HERE (the same takeAttachments
        // semantics the live send uses) and its chips ride the drain send — an
        // attachment-only mid-run hold is a real send, not a phantom, and
        // nothing the guest staged is dropped by the hold.
        const guestHold = stageChatlessBehindLive({ liveRunning: true, guest: !!plainCfg.guest });
        const heldAtts = guestHold && !escalationOf ? (plainCfg.takeAttachments?.() ?? []) : [];
        if (guestHold && (message.trim() || heldAtts.length > 0)) {
          if (!overrideMessage && !escalationOf) { composerRef.current?.clear(); voice.discardRecording(); }
          const item = makeGuestQueued({ message, uploads: heldAtts });
          setGuestQueue([...guestQueueRef.current, item]);
          pinnedRef.current = true; capTopRef.current = null; sentAtRef.current = Date.now(); setShowJumpToEnd(false);
        }
        return;
      }
      // overrideUploads (ticket 625773b5): a drained guest hold carries the
      // chips it snapshotted at hold time — the bar is already empty by then.
      const atts = escalationOf
        ? []
        : (opts?.overrideUploads ?? plainCfg.takeAttachments?.() ?? []);
      if (!message && atts.length === 0 && !escalationOf) return;
      const sid = chatId;
      const uploadIds = atts.map(a => a.uploadId);
      // Attachment-only send: the pipeline needs SOME text to work with (the
      // legacy view used the same placeholders); the bubble shows just the
      // attachment chips — not the placeholder text.
      const effectiveMessage = escalationOf ? ESCALATE_LABEL : message || (atts.some(a => a.type === 'image')
        ? 'Describe and analyze the attached image(s).'
        : 'Analyze the attached file(s).');
      // An escalation echo carries escalationOf so the chip ladder counts the
      // rungs already spent on that answer (countSpentEscalations).
      const echoMeta = escalationOf
        ? { escalationOf }
        : atts.length
          ? { attachments: atts.map(a => ({ filename: a.filename, type: a.type, localPreview: a.localPreview })) }
          : undefined;
      // A Dig-deeper tap is not a composer submit: the typed draft and any
      // in-progress voice recording stay exactly where they are.
      if (!overrideMessage && !escalationOf) { composerRef.current?.clear(); voice.discardRecording(); }
      pinnedRef.current = true; capTopRef.current = null; sentAtRef.current = Date.now(); setShowJumpToEnd(false);
      const echoId = `tmp-${Date.now()}`;
      sendStartedRef.current = { at: Date.now(), mode: plainCfg.mode, ...(escalationOf ? { escalationOf, echoId } : {}) };
      dropTrackerRef.current.reset(); // a new send starts a new stream — an open drop episode is over (stream drops 2026-10-20)
      // displayContent (C3 blocker 1 — legacy semantics): a hand-off may carry
      // a clean bubble label (news follow-ups display a short line, send a
      // long prompt). Echo-only; the SERVER gets effectiveMessage below.
      const echoContent = opts?.displayContent !== undefined ? opts.displayContent : escalationOf ? ESCALATE_LABEL : message;
      const echoMsg: CodingMessage = { id: echoId, role: 'user', content: echoContent, plainMeta: echoMeta, createdAt: new Date().toISOString() };
      setMessages(prev => [...prev, echoMsg]);
      // A refusal frame on this stream retracts THIS echo (depth-ux-seams.ts).
      escalationInFlightRef.current = escalationOf ? { echoId, escalationOf } : null;
      // Guest sessions (63bb607f): mirror the echo into the browser-local
      // store immediately (a refresh mid-answer still keeps the question).
      plainCfg.onTranscriptChange?.([...messagesRef.current, echoMsg]);
      if (live.running) {
        if (!sid) return; // unreachable (chatless guard above) — narrows sid for the queue call
        setPendingSteerIds(prev => new Set(prev).add(echoId));
        // Ticket b54efe5d: the composer's send circle now has ONE meaning —
        // queue behind the live answer. Interrupting is its own small button
        // (ChatComposer's onInterrupt), which reaches here with opts.interrupt:
        // the message is still enqueued (nothing is lost either way), and the
        // row is promoted + the live run stopped so the drain delivers it next.
        void queuePlainBehindLive(sid, effectiveMessage, plainCfg, uploadIds, {
          onQueued: ({ pendingId, position }) => {
            if (position === null) return;
            // Ticket 81b229e1: record the EXACT pairing so reloadPlain drops
            // this echo in favour of the row it became (identity, not a clock
            // guess — promote re-stamps the row's createdAt).
            if (pendingId) plainEchoToPendingRef.current.set(echoId, pendingId);
            // Reflect the true position in the caption immediately, then let the
            // server listing own the order.
            if (opts?.interrupt && pendingId && !plainCfg.guest) {
              void promoteThenStop(sid, pendingId);
            }
            void refreshQueue(sid);
          },
        });
        return;
      }
      setLive({ parts: [], pendingApproval: null, running: true });
      setRunStart(Date.now());
      setRunning(sid, true);
      try {
        const url = await buildPlainStreamUrl({ chatId: sid, message: effectiveMessage, mode: plainCfg.mode, modeSource: plainCfg.modeSource, webSearch: plainCfg.webSearch, uploadIds, sessionId: plainCfg.guestSessionId, userLocation: plainCfg.guest ? plainCfg.guestLocation?.() : undefined, escalationOf, ghost: plainCfg.ghost });
        // Chat switched while the >1500-char register POST was in flight — don't
        // leave the sidebar "running" dot stuck (review M6b).
        if (activeIdRef.current !== sid) { setRunning(sid, false); return; }
        connectStream(sid, '', { url });
      } catch {
        toast.error('Could not send the message.');
        setLive({ parts: [], pendingApproval: null, running: false });
        setRunning(sid, false);
      }
      return;
    }
    const sendRoute = routeSend({
      hasSession: !!activeSession,
      hasContent: !!(message || (overrideImages?.length ?? pendingImages.length) || (opts?.overrideUploads ?? pendingUploads).length),
      liveRunning: live.running,
      sessionStatus: activeSession?.status,
      bypassRunningGuard: opts?.bypassRunningGuard,
    });
    if (sendRoute === 'skip') return;
    if (sendRoute === 'steer-reroute') {
      // status 'running' with no live stream = the run survived a deploy (or is
      // queued behind other runs) but our SSE died — reconcile + reattach
      // instead of dead-ending the user with a generic toast.
      // The run is alive SERVER-side even though our stream isn't attached —
      // steer the message NOW (the server persists it and folds it into the
      // run at its next step) instead of swallowing it behind a reconnect
      // toast (owner 2026-08-28: "if I smash enter a bunch of times
      // eventually I can get the message queued in" — each Enter only
      // resynced, and the message finally sent once a resync re-attached).
      void resyncActive();
      void steer();
      return;
    }
    if (sendRoute === 'queue-until-ready' && activeSession) {
      // Owner 2026-10-14: never "still provisioning — one moment". Keep the
      // message (text + images + staged uploads), clear the composer like a
      // real send, echo it as a queued bubble, and let the drain effect send
      // it the moment the session reads 'ready'.
      const item = makeQueued({
        message,
        images: overrideImages ?? pendingImages.map(({ mediaType, data, name }) => ({ mediaType, data, name })),
        uploads: opts?.overrideUploads ?? pendingUploads,
      });
      if (overrideMessage === undefined) {
        composerRef.current?.clear();
        voice.discardRecording();
        setPendingImages([]);
        setPendingUploads([]);
        setImageNote(null);
      }
      setProvisionQueue(activeSession.id, [...provisionQueueRef.current, item]);
      pinnedRef.current = true; capTopRef.current = null; sentAtRef.current = Date.now(); setShowJumpToEnd(false);
      return;
    }
    if (sendRoute === 'blocked-toast') {
      toast.error(activeSession?.status === 'error' ? 'This session errored while provisioning. Create a new one.'
        : 'This session isn’t ready.');
      return;
    }
    // Narrowing for everything below (routeSend returned 'proceed' ⇒ a
    // session exists, but TS can't see through the helper).
    if (!activeSession) return;
    const sid = activeSession.id;
    const tmpId = `tmp-${Date.now()}`;
    // Auto-start sends carry the composer's initial images as an override;
    // interactive sends read the composer tray (pendingImages).
    const images: ChatImage[] = overrideImages ?? pendingImages.map(({ mediaType, data, name }) => ({ mediaType, data, name }));
    const imagesBackup = overrideImages ?? pendingImages;
    // 7b5ee09b: staged document uploads ride the run body as uploadIds.
    // overrideUploads: a drained provision queue carries its own chips.
    const uploadsSource = opts?.overrideUploads ?? pendingUploads;
    const uploadIds = uploadsSource.map(a => a.uploadId);
    const uploadsBackup = uploadsSource;
    if (!overrideMessage) {
      composerRef.current?.clear();
      // Mic auto-off ATOMIC with the clear (review M1 round 2): discarding only
      // after the startRun await left recognition live during the POST, so
      // trailing speech re-wrote the just-cleared composer and survived.
      // On failure the catch restores the draft; "hitting send turns the mic
      // off" (0c256c3a) holds regardless of the send's outcome.
      voice.discardRecording();
      setPendingImages([]);
      setPendingUploads([]);
      setImageNote(null);
    }
    pinnedRef.current = true; capTopRef.current = null; sentAtRef.current = Date.now(); setShowJumpToEnd(false);
    setMessages(prev => [...prev, {
      id: tmpId, role: 'user', content: message, createdAt: new Date().toISOString(),
      ...(images.length ? { parts: [{ type: 'text' as const, text: message }, ...images.map(i => ({ type: 'image' as const, ...i }))] } : {}),
    }]);
    // Preserve `context` (the sidebar meter) across sends — replacing the whole
    // live object collapsed the Context section on EVERY send (visible flicker
    // + "the meter keeps wiping", owner-reported 2026-07-18).
    setLive(l => ({ parts: [], pendingApproval: null, running: true, context: l.context, processes: l.processes }));
    setRunStart(Date.now());
    setRunning(sid, true);
    try {
      await codingApi.startRun(sid, message, images, uploadIds);
      // Re-stamp the sidebar-mark grace window NOW: the server flipped
      // ready→running synchronously inside this POST, so from here the
      // reconcile poll can't prune a genuinely-running session (the pre-await
      // stamp let a >15s slow upload blink the spinner off — review M1).
      setRunning(sid, true);
    } catch (e: any) {
      const busy = e?.response?.status === 409;
      // Surface the backend's own message (e.g. the non-vision 400 that names
      // the configured model) instead of a bare generic — the optimistic
      // message is already rolled back either way.
      toast.error(busy
        ? 'A run is already in progress for this session.'
        : (e?.response?.data?.error || 'Could not start the run.'));
      setMessages(prev => prev.filter(m => m.id !== tmpId));
      setLive(l => ({ parts: [], pendingApproval: null, running: false, context: l.context, processes: l.processes }));
      setRunning(sid, false);
      // Restore the message so the user can retry — but never clobber a draft
      // they typed while an override (auto-start) message was in flight.
      if (!busy) {
        const cur = composerRef.current?.getValue() ?? '';
        if (!(overrideMessage !== undefined && cur.trim())) composerRef.current?.setValue(message);
        // imagesBackup may be override (ChatImage — no previewUrl/name guarantees);
        // rebuild the composer-tray shape, reusing the tray's own preview when present.
        if (imagesBackup.length) setPendingImages(imagesBackup.map(i => ({
          mediaType: i.mediaType, data: i.data,
          name: i.name ?? 'image',
          previewUrl: (i as { previewUrl?: string }).previewUrl ?? `data:${i.mediaType};base64,${i.data}`,
        })));
        // Restore the staged document chips too (7b5ee09b) — the Redis blobs
        // still hold their TTL, so a retry can ride the same uploadIds.
        if (uploadsBackup.length) setPendingUploads(uploadsBackup);
      }
      return;
    }
    if (activeIdRef.current !== sid) return;
    connectStream(sid, '', { attach: true });
  };

  // STEER: send a message INTO the running agent (folded in at its next step).
  const steer = async () => {
    const message = (composerRef.current?.getValue() ?? '').trim();
    if (plainRef.current) {
      // Plain chats have no steer — send() hands the message to the server's
      // busy-queue instead (P2 increment 2 passthrough; a second live SSE
      // would clobber the running stream, so the queue request rides a
      // throwaway connection there).
      void send();
      return;
    }
    if (!activeSession || (!message && !pendingImages.length && !pendingUploads.length) || (!live.running && activeSession.status !== 'running') || steering) return;
    const images: ChatImage[] = pendingImages.map(({ mediaType, data, name }) => ({ mediaType, data, name }));
    const uploadIds = pendingUploads.map(a => a.uploadId);
    setSteering(true);
    try {
      await codingApi.steerRun(activeSession.id, message, images, uploadIds);
      voice.discardRecording();
      composerRef.current?.clear();
      setPendingImages([]);
      setPendingUploads([]);
      setImageNote(null);
      // Optimistic echo as a REAL user bubble. The steer is persisted server-
      // side as a user message (coding-stream.controller.ts steerRun), so this
      // matches reload state exactly — until now nothing echoed locally, so a
      // steer sent mid-run was invisible (the "queued messages not displayed"
      // bug). Captioned as queued until the run ends; the 'steer' SSE event
      // also lands in live parts (↳ steering: …) as the agent's fold-in signal.
      const steerId = `steer-${Date.now()}`;
      setMessages(prev => [...prev, {
        id: steerId,
        role: 'user',
        content: message,
        parts: [
          ...(message ? [{ type: 'text', text: message }] : []),
          ...images.map(i => ({ type: 'image', mediaType: i.mediaType, data: i.data, name: i.name })),
        ] as CodingMessage['parts'],
        createdAt: new Date().toISOString(),
      }]);
      setPendingSteerIds(prev => new Set(prev).add(steerId));
      pinnedRef.current = true; capTopRef.current = null; sentAtRef.current = Date.now(); setShowJumpToEnd(false);
    } catch (e: any) {
      if (classifySteerFailure(e?.response?.status) === 'fallback-send') {
        // Server-authoritative "no active run" — the local running flag is
        // STALE (SSE 'complete' missed: deploy flip, suspended tab, silently
        // dead stream). Reconcile BEFORE falling back: the old code called
        // send() directly, which re-checked the same stale flag and silently
        // no-oped — every Enter was a dead end with zero feedback, and the
        // draft could never be delivered (ticket 55e9967d — "I can't send
        // anything to this session"). Close the dead stream + reconnect timer
        // so the fresh run attaches cleanly, then send with an explicit
        // bypass (React state hasn't flushed yet — send() would still read
        // live.running=true from this render's closure).
        const es = esRef.current; esRef.current = null; es?.close();
        if (reconnectRef.current.timer) { clearTimeout(reconnectRef.current.timer); reconnectRef.current.timer = null; }
        setLive(l => ({ ...l, parts: [], workers: undefined, verify: undefined, status: undefined, steps: undefined, running: false, pendingApproval: null }));
        setRunning(activeSession.id, false);
        void send(message, undefined, { bypassRunningGuard: true });
        // Clear the just-delivered draft (review NB1): send() captured the
        // message + image tray synchronously above, and leaving them in the
        // composer let a second Enter steer the SAME text into the fresh run
        // (double-send). On a failed send the draft self-restores — the
        // override-restore guard only skips when the composer is non-empty.
        composerRef.current?.clear();
        setPendingImages([]);
        setPendingUploads([]);
        setImageNote(null);
      } else {
        toast.error('Could not steer the run');
      }
    } finally { setSteering(false); }
  };

  const stopRun = async () => {
    if (plainRef.current) {
      // Plain stop (review H2): the stream's ES lives in THIS view — routing
      // through the page's handleStop closed only the page's (null) ES and was
      // a complete no-op that left the run streaming while lying "Stopped".
      setLive(l => ({ ...l, stopping: true }));
      esRef.current?.close(); esRef.current = null;
      setLive({ parts: [], pendingApproval: null, running: false });
      setRunning(chatId, false);
      // Cancel the run server-side too — an agent run parked on a question
      // otherwise waits up to 60 min and keeps executing. (Chatless C3 sends
      // have no per-chat endpoints — closing the ES above IS the stop.)
      if (chatId) {
        void crossModelApi.stopAgentRun(chatId).catch(() => {});
        void reloadPlain(chatId);
      }
      toast.info('Stopped ✋');
      return;
    }
    if (!activeSession) return;
    setLive(l => ({ ...l, stopping: true }));
    try {
      const r = await codingApi.stopRun(activeSession.id);
      if (!r.stopping) {
        esRef.current?.close();
        setLive(l => ({ parts: [], pendingApproval: null, running: false, context: l.context, processes: l.processes }));
        setRunning(activeSession.id, false);
        reloadSession(activeSession.id);
      }
    } catch {
      toast.error('Could not stop the run');
      setLive(l => ({ ...l, stopping: false }));
    }
  };

  /**
   * "Send now" for a plain chat (ticket ea04454c): PROMOTE the just-queued row
   * to the head, then STOP the live run so the finishing run's drain delivers it
   * immediately. Promoted first, stopped second — reversing the order would let
   * the drain pick a DIFFERENT row in the gap between the two calls.
   *
   * Fail-open by design: if the promote fails the message is still queued (it
   * will run when this turn finishes — exactly today's behaviour), so the
   * person never loses the text; they just keep waiting.
   */
  const promoteThenStop = async (sid: string, pendingId: string) => {
    try {
      const promoted = await crossModelApi.promoteChatQueueItem(sid, pendingId);
      if (activeIdRef.current !== sid) return;
      setQueueItems(withPositions(promoted));
    } catch {
      toast.error('Could not move that message to the front — it stays queued.');
      return;
    }
    toast.message('Sending now', { description: 'Stopping the current answer so your new message runs next.' });
    await stopRun();
  };

  /**
   * "Send now" on a CODING run (ticket ea04454c): stop the live run, wait for it
   * to actually settle, then start the typed message as its own turn.
   *
   * ORDER AND THE SETTLE WAIT BOTH MATTER (adversarial review, blocking #1):
   *  - sending first would simply STEER the run we are about to cancel, and the
   *    text dies with it;
   *  - sending immediately after the stop is refused too: stopRun only sets a
   *    cooperative cancel flag, so the session row is still `running` and
   *    queueAgentRun's ready→running gate answers 409 "A run is already in
   *    progress" — the run dies AND the message is never sent (the worst of
   *    both). So poll the session until it reports ready, bounded.
   *
   * Fail-safe: the draft is only cleared by send() when it SUCCEEDS, so if the
   * wait times out the person's text is still in the composer, with an honest
   * note that it was not sent.
   */
  const interruptWithMessage = async () => {
    const message = (composerRef.current?.getValue() ?? '').trim();
    const images = pendingImages.slice();
    const uploads = pendingUploads.slice();
    if (!message && !images.length && !uploads.length) return;
    const sid = activeSession?.id;
    if (!sid) return;
    await stopRun().catch(() => {});
    // Bounded settle wait (~24 s): the worker polls its cancel flag every 2 s.
    let settled = false;
    for (let i = 0; i < 12 && !settled; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      if (activeIdRef.current !== sid) return; // chat switched mid-wait
      const s = await codingApi.getSession(sid, { messageLimit: 1 }).catch(() => null);
      settled = !!s && (s as any).status === 'ready';
    }
    if (!settled) {
      toast.error('Could not stop the run in time — your message was kept in the composer, not sent.', {
        description: 'Send it again once the run has stopped.',
      });
      return;
    }
    await send(message, images.length ? images : undefined, { bypassRunningGuard: true, overrideUploads: uploads.length ? uploads : undefined });
  };

  const respondApproval = async (decision: 'allow' | 'always' | 'deny') => {
    if (!live.pendingApproval) return;
    await codingApi.approve(live.pendingApproval.approvalId, decision).catch(() => {});
    setLive(l => ({ ...l, pendingApproval: null }));
  };

  // ── Queued-message controls (ticket ea04454c) ──────────────────────────────
  // Refresh the caller's own queue from the server (drain order is server truth;
  // the panel never invents an order). Cheap: one indexed read, only called
  // while a run is live or right after a control action.
  const refreshQueue = useCallback(async (sid: string | null) => {
    if (!sid) { setQueueItems([]); return; }
    try {
      const items = await crossModelApi.listChatQueue(sid);
      if (activeIdRef.current !== sid) return;
      setQueueItems(items);
    } catch { /* the panel keeps its last known order; controls still work */ }
  }, []);

  /** Shared wrapper: run a control call, adopt whatever queue it returns, and
   *  name a refusal honestly instead of failing silently. */
  const runQueueControl = async (fn: () => Promise<QueuedItem[]>) => {
    setQueueBusy(true);
    try {
      setQueueItems(withPositions(await fn()));
    } catch (err: any) {
      // Every control endpoint returns the FRESH queue even on a refusal, so a
      // stale click recovers in ONE hop instead of needing a separate GET.
      const fresh = queueFromError(err);
      if (fresh) setQueueItems(withPositions(fresh));
      toast.error(queueRefusalMessage(refusalCodeFromError(err)));
      if (!fresh && chatId) void refreshQueue(chatId);
    } finally {
      setQueueBusy(false);
    }
  };

  const cancelQueued = (pendingId: string) => {
    if (!chatId) return;
    void runQueueControl(() => crossModelApi.cancelChatQueueItem(chatId, pendingId));
  };

  const moveQueued = (pendingId: string, direction: 'up' | 'down') => {
    if (!chatId) return;
    // Optimistic first (the click feels instant), then adopt server truth.
    setQueueItems(prev => withPositions(moveItem(prev, pendingId, direction)));
    void runQueueControl(() => crossModelApi.moveChatQueueItem(chatId, pendingId, direction));
  };

  /**
   * "Run now" on a queued message: PROMOTE it to the head and STOP the live run
   * so the drain picks it up immediately. Two ordered steps, because the drain
   * only reads the queue when the current run's finally fires — promoting alone
   * would just make it next whenever the person's current answer ends.
   */
  const runQueuedNow = async (pendingId: string) => {
    if (!chatId) return;
    setQueueBusy(true);
    try {
      const promoted = await crossModelApi.promoteChatQueueItem(chatId, pendingId);
      setQueueItems(withPositions(promoted));
    } catch (err: any) {
      const fresh = queueFromError(err);
      if (fresh) setQueueItems(withPositions(fresh));
      toast.error(queueRefusalMessage(refusalCodeFromError(err)));
      setQueueBusy(false);
      return;
    }
    setQueueBusy(false);
    // Now end the live run so the promoted row is delivered (the same cancel
    // path the Stop button uses — never a second, parallel stop mechanism).
    await stopRun();
  };

  /**
   * Keep the queued-message panel truthful (ticket ea04454c): reload it when a
   * run starts or ends and while anything is still queued. The server owns the
   * order — the panel never guesses — so this one read is what makes a promote,
   * cancel or reorder look right after a drain.
   */
  useEffect(() => {
    if (!chatId) { setQueueItems([]); return; }
    // Idle with nothing queued: nothing to show, no request.
    if (!live.running && queueItems.length === 0) return;
    void refreshQueue(chatId);
    // queueItems is deliberately NOT a dependency (this effect feeds it); the
    // run/idle transition is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, live.running, refreshQueue]);

  // Live countdown for a pending question's soft deadline. expiresAt is an
  // ABSOLUTE epoch — a throttled background interval just recomputes the true
  // remaining on its next fire (and foreground forces an immediate tick). At
  // zero the card clears like a resolved question: no doomed click on a dead
  // wait (the server grace window still absorbs an answer already in flight).
  const [questionNow, setQuestionNow] = useState(() => Date.now());
  const questionExpiresAt = live.pendingQuestion?.expiresAt ?? null;
  useEffect(() => {
    if (questionExpiresAt == null) return;
    const tick = () => {
      const now = Date.now();
      setQuestionNow(now);
      if (now >= questionExpiresAt) setLive(l => (l.pendingQuestion ? { ...l, pendingQuestion: null } : l));
    };
    const iv = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', tick); };
  }, [questionExpiresAt]);
  const questionRemainMs = questionExpiresAt != null ? questionExpiresAt - questionNow : null;
  // What the answer box's send button sends: a multi-pick card sends the picks (+ the typed note).
  const questionAnswer = live.pendingQuestion?.multiSelect
    ? composeMultiSelectAnswer(live.pendingQuestion.options, questionPicks, questionDraft)
    : questionDraft;

  const answerQuestion = async (text: string) => {
    const q = live.pendingQuestion;
    const answer = text.trim();
    if (!q || !answer) return;
    setLive(l => ({ ...l, pendingQuestion: null }));
    setQuestionDraft('');
    setQuestionPicks(new Set());
    if (plainRef.current?.onAnswerQuestion) { plainRef.current.onAnswerQuestion(q.questionId, answer); return; }
    await codingApi.answerQuestion(q.questionId, answer)
      .then((res) => {
        // 992c8374: a swallowed success:false looked EXACTLY like a sent answer
        // — the card cleared, the wait never resolved, the next wake re-asked.
        if (!res || res.success === false) {
          toast.error('That question had already closed — your answer did not land. If the card reappears, answer the new one.');
        }
      })
      .catch(() => {
        toast.error('Could not send your answer');
      });
  };

  // ── Plan / goal / todos ──
  const guardPlanEdit = (): string | null => {
    if (!activeSession) return null;
    if (live.running) { toast.error('The agent is running — the plan is locked.'); return null; }
    return activeSession.id;
  };
  const addTodo = async (text: string) => {
    const sid = guardPlanEdit(); if (!sid) return;
    try { setPlan(await codingApi.addTodo(sid, text)); } catch { toast.error('Could not add todo'); }
  };
  const cycleTodo = async (step: PlanStep) => {
    const sid = guardPlanEdit(); if (!sid) return;
    const next: TodoStatus = step.status === 'pending' ? 'in_progress' : step.status === 'in_progress' ? 'completed' : 'pending';
    try { setPlan(await codingApi.setTodoStatus(sid, step.id, next)); } catch { toast.error('Could not update todo'); }
  };
  const deleteTodo = async (step: PlanStep) => {
    const sid = guardPlanEdit(); if (!sid) return;
    try { setPlan(await codingApi.deleteTodo(sid, step.id)); } catch { toast.error('Could not delete todo'); }
  };
  const saveGoal = async (goal: string) => {
    const sid = guardPlanEdit(); if (!sid) return;
    try { setPlan(await codingApi.setGoal(sid, goal)); } catch { toast.error('Could not save goal'); }
  };

  // ── Render ──
  if (loadFailed === 'deleted') {
    // Owner 2026-10-27 ("deleted chat still sits in the chat if you have it
    // open"): terminal, honest, never retryable — every probe 404s and either
    // way a retry affordance would just re-404. The sidebar row is already
    // dropped (the page cleared the mount); this arm is the last defense for a
    // view whose chat died while mounted. Copy (review round 2, defect 3): the
    // 404 is ACCESS-gated, not existence-gated — "deleted" and "read access
    // revoked" (unshared, membership changed) are indistinguishable, so the
    // copy names availability to THIS USER, never a bare claim of deletion.
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm px-6 text-center">
        {plain
          ? 'This chat is no longer available to you — it may have been deleted, moved, or unshared.'
          : 'This session is no longer available to you — it may have been deleted, moved, or unshared.'}
      </div>
    );
  }
  if (loadFailed === 'no_workspace') {
    // Honest satellite-less copy (User Space P3, spec §5): the coding GET 404s
    // when the chat has no ChatCodingState satellite — not "archived/deleted".
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm px-6 text-center">
        This chat doesn&apos;t have a workspace yet — it picks one up when a task needs it, or attach one from the ⋯ menu.
      </div>
    );
  }
  if (loadFailed === 'error') {
    // P4: a real load failure (network/5xx/plain-transcript) shows a retryable
    // error instead of the wrong workspace copy or an eternal spinner.
    return (
      <div className="flex flex-1 min-w-0 flex-col">
      {header}
      <div className="flex-1 flex items-center justify-center">
        <LoadErrorState
          message={plain ? "Couldn't load this chat." : "Couldn't load this session."}
          onRetry={() => setLoadNonce((n) => n + 1)}
        />
      </div>
      </div>
    );
  }
  if (!activeSession && !plain) {
    return (
      <div className="flex flex-1 min-w-0 flex-col">
      {header}
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <DigbyLoader size={40} label="Opening session" />
      </div>
      </div>
    );
  }

  // Plain mode renders at the user's chat text-size preference; coding keeps
  // the dense transcript scale (sizes undefined → component defaults).
  const plainSizes = plain ? TEXT_SIZE_MAP[prefs.chatTextSize] : undefined;
  // Live-bubble strip (review H3): the raw accumulation stays authoritative,
  // but rendered text must never flash [CANVAS]/[FOLLOWUPS]/[SEND_EMAIL]
  // markup mid-stream — same render-time strip the legacy view applies.
  const liveRenderParts = plain
    ? live.parts.map(p => (p.type === 'text' ? { ...p, text: stripLiveTags(p.text || '') } : p))
    : live.parts;
  // Composer run chrome (owner, prod 2026-09-27: a reload mid-answer reopened
  // the guest chat with the calm resume line AND the red Stop + "Digby is
  // replying — … Stop ends it." footer, although nothing was attached in that
  // tab — the resume is a 5 s poll, Stop had nothing to stop). The Stop
  // button, the queue / steer submit variant and the footer key on a LIVE
  // CONNECTION (`live.source` unset) — never on the bare running flag; a
  // polled resume gets a neutral hint. depth-ux-seams.ts composerRunAffordance.
  const composerRun = composerRunAffordance({ running: live.running, source: live.source, plain: !!plain, chatId, sessionStatus: activeSession?.status });

  // Ticket 7acaa7ba: a signed-in viewer who is NOT the session owner (a project
  // member) can read + watch but never start/steer runs — the server enforces
  // this (CODING_OWNER_ONLY 403); the composer mirrors it honestly instead of
  // letting the member type a message the server will reject.
  const memberViewOnly = !!viewerId && !!activeSession?.userId && viewerId !== activeSession.userId;

  return (
    <WorktreeOpenContext.Provider value={plain ? null : openWorktreeFile}>
    <TaskCardActionsContext.Provider value={taskActions}>
    <ChatOpenContext.Provider value={onOpenChat ?? null}>
    <div className="flex flex-1 min-h-0 min-w-0">
      <div className="flex-1 flex flex-col min-w-[min(380px,100%)]">
        {/* Digby Frontier header (2026-10-06): the host's in-flow 56px chat
            header sits ABOVE the transcript (it pads the notch / Dynamic
            Island itself), so the transcript starts right under it. */}
        {header}
        <div className="relative flex-1 min-h-0 flex flex-col">
          <div
            ref={scrollRef}
            onScroll={onTranscriptScroll}
            className="flex-1 overflow-y-auto overflow-x-hidden px-4 sm:px-6 pb-10"
            style={{ paddingTop: '12px' }}
          >
          {/* Inner content wrapper — observed by the pin ResizeObserver so async
              growth (markdown/highlight/images) keeps the view glued while
              pinned. space-y moved here from the scroller; min-h-full keeps the
              empty state filling the viewport. Centered at the app's ONE
              reading measure (P2 item 1) — the composer below shares the same
              token so the two edges align on every viewport. */}
          <div ref={transcriptContentRef} className={cn('mx-auto w-full max-w-(--measure-chat) min-h-full', plain ? 'space-y-[30px]' : 'space-y-5')}>
            {/* Inline task card (cohesive chat, 2026-09-28): a finished
                SUB-SESSION leads with its Result — the deliverables + links
                the parent chat's card carries — instead of only a status line
                (owner: the finished deck lived only in the Files tab). Coding
                sessions only; hidden while a run is live. */}
            {sessionResult && <TaskResultSection task={sessionResult} />}
            {messages.length === 0 && !live.running && (
              <div className="h-full min-h-[40vh] flex flex-col items-center justify-center text-center text-muted-foreground gap-2 px-6">
                {plain ? (
                  <>
                    {/* Owner 2026-09-15: the empty chat state shows the Digby hat.
                        Digby Frontier (2026-10-06): the home hero's language —
                        the owner's animated propeller hat (DigbyLoader) beside a sans greeting. */}
                    <div className="dg-rise-hero flex flex-col items-center gap-3">
                      <div className="flex items-center justify-center gap-3">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <DigbyLoader size={40} label={branding.name} />
                        <p className="text-[26px] font-medium leading-[1.15] tracking-[-0.015em] text-ink">Ask {branding.name} anything</p>
                      </div>
                      <p className="text-[13.5px] text-ink-3 max-w-sm">Answers stream live here — with the work trail shown as it happens.</p>
                    </div>
                  </>
                ) : (
                  <>
                    <FolderGit2 className="size-8 text-brand-accent/70" />
                    <p className="text-sm font-medium text-foreground">Start coding on <span className="font-mono">{activeSession?.branch}</span></p>
                    <p className="text-xs max-w-sm">Ask Digby to build a feature, fix a bug, or explain the codebase. It edits files, runs commands, and can open a PR — all in an isolated worktree.</p>
                  </>
                )}
              </div>
            )}
            {reasoningVisible() && hasAnyReasoning && (
              <div className="flex justify-end">
                <button
                  onClick={() => setHideThinking(h => !h)}
                  className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[10px] text-muted-foreground/70 hover:text-muted-foreground hover:bg-muted/50 select-none"
                  title={hideThinking ? 'Show thought rows and chips again' : 'Collapse all thought rows and join the surrounding prose'}>
                  <Brain className="size-3" />
                  {hideThinking ? 'Show thinking' : 'Hide thinking'}
                </button>
              </div>
            )}
            {(visibleCount >= MAX_VISIBLE && (history.length > visibleCount || plainPaging.hasMore || codingPaging.hasMore)) ? (
              // Render ceiling: past MAX_VISIBLE rows the per-message markdown +
              // shiki cost turns every live-stream frame into a stall. Rows stay
              // loaded; the window just stops growing.
              <div className="flex justify-center">
                <span className="text-[11px] text-muted-foreground/70 select-none">
                  Showing the latest {MAX_VISIBLE} messages — earlier history stays hidden for performance.
                </span>
              </div>
            ) : (history.length > visibleCount || plainPaging.hasMore || codingPaging.hasMore) && (
              // Auto-load on scroll-up (owner 2026-09-23: "you shouldn't have
              // to click load more"): this sentinel sits above the oldest
              // rendered row; the IntersectionObserver below reveals the next
              // local window / fetches the next server page when it scrolls
              // into the 400px approach band — only while the reader has
              // scrolled UP (unpinned), so a short transcript never
              // self-loads its whole history on open. The pill is status
              // only; the button remains as a keyboard/fallback affordance.
              <div ref={topSentinelRef} data-slot="earlier-sentinel" className="flex justify-center min-h-6">
                <button
                  onClick={() => loadEarlierRef.current()}
                  disabled={loadingEarlier}
                  className="text-[11px] text-muted-foreground/80 rounded-full border border-border/60 px-3 py-0.5 hover:bg-muted disabled:opacity-60">
                  {loadingEarlier
                    ? 'Loading earlier messages…'
                    : history.length > visibleCount
                      ? `${history.length - visibleCount} earlier messages — scroll up to load`
                      : 'Earlier messages — scroll up to load'}
                </button>
              </div>
            )}
            {/* Queued echoes are NOT rendered at their array position (08d31b1a).
                The array position IS their chronological record (3d6a8cb2): the
                steer/queue echo is appended at send time and the server persists
                the steer at send time too (createdAt asc on reload matches), so
                the ROW stays in the array exactly where the user sent it. But
                the LIVE run block renders after this whole list and grows
                thousands of px tall in a coding session — an echo rendered at
                its array slot lands at the live block's TOP edge, far above the
                pinned viewport, so the user never saw it land (the "queued
                messages appear very high up" bug). They are partitioned OUT of
                this list (history) and rendered in-flow AFTER the live block,
                just above the composer — where the user's attention actually is.
                On run complete pendingSteerIds clears and the server-persisted
                row takes its true chronological slot via reloadSession (echo ids
                are `steer-*`/`tmp-*`, never colliding with server ids). */}
            {(() => {
              const slice = history.slice(Math.max(0, history.length - visibleCount));
              // Follow-up chips only under the LATEST answer (audit 2026-09-15,
              // the Claude/ChatGPT convention): stale suggestions under every
              // old turn read as clutter and invite replying to the past.
              // Audit sse-ui-restore-14 (2026-09-26): the anchor skips a check
              // ADDENDUM row (a late correction footnote under a newer turn —
              // it carries no chips), so the latest real answer keeps its
              // follow-ups + Dig-deeper control (depth-ux-seams.ts chipAnchorId).
              const lastAssistantId: string | undefined = chipAnchorId(history);
              // Inline canvas cards: which answer produced which canvas.
              const canvasesByAnswer = plain?.canvases?.length && plain.onOpenCanvas
                ? attachCanvasesToMessages(history, plain.canvases)
                : null;
              // Owner 2026-09-29: only the NEWEST project status card renders in
              // full; every older one is a single expandable line (the hourly
              // cards were the longest rows in a supervisor chat).
              let latestProjectStatusId: string | undefined;
              for (let i = history.length - 1; i >= 0; i--) {
                const h = history[i];
                if (h.role === 'assistant' && classifyAssistantCard({ role: 'assistant', content: h.content, metadata: h.plainMeta }) === 'project-status') { latestProjectStatusId = h.id; break; }
              }
              const statusSupersededFor = (m: CodingMessage) => !!latestProjectStatusId && m.id !== latestProjectStatusId;
              // Depth UX (2026-09-26): which chip an assistant row shows —
              // FAIL-CLOSED on the SERVER's chips (plainMeta.chips: the
              // followups/complete event or persisted metadata.chips). Kids
              // never see one (the kid pipeline has no rungs); guests get the
              // server's sign-in affordance; a machine-origin row (supervisor /
              // scheduled reply) never carries one; a stored level or
              // metadata.mode can NOT invent one (a tap posts a paid turn).
              const digDeeperChipFor = (m: CodingMessage) => {
                if (m.role !== 'assistant' || !plain) return null;
                return escalationChipFor({
                  chips: m.plainMeta?.chips,
                  depth: m.plainMeta?.depth,
                  origin: m.plainMeta?.origin,
                  messageId: m.id,
                  guest: !!plain.guest,
                  spent: countSpentEscalations(history.map(h => ({ role: h.role, escalationOf: h.plainMeta?.escalationOf })), m.id),
                  isLast: m.id === lastAssistantId,
                  running: live.running,
                  enabled: !isKid && plain.digDeeperEnabled !== false && (!!chatId || !!plain.guest),
                });
              };
              // Machine-turn grouping (platform task, owner report 2026-09-02):
              // consecutive machine rows — wakes/relays/system notices plus the
              // assistant replies they produced — collapse into ONE accordion
              // group (see lib/machine-turn-grouping.ts). Human rows never
              // enter a group (collapse, never filter).
              // Off-screen rows stay in the DOM but are NOT laid out/painted
              // until they approach the viewport (owner 2026-09-23: "still
              // doesn't render unless you scroll up to save browser memory"):
              // `content-visibility:auto` skips rendering work for rows far
              // above the fold; `contain-intrinsic-size` keeps the scrollbar
              // honest with the row's last known height. The newest rows
              // (the live tail's neighbours) are left fully rendered so the
              // pin/anchoring math never sees a placeholder.
              const RECENT_FULLY_RENDERED = 8;
              const renderHistoryRow = (m: (typeof slice)[number]) => {
                const idx = slice.indexOf(m);
                const deferRender = idx >= 0 && idx < slice.length - RECENT_FULLY_RENDERED;
                const row = renderHistoryRowInner(m);
                return deferRender
                  ? <div key={m.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_160px]">{row}</div>
                  : row;
              };
              // Digby Frontier: a freshly sent user row rises in (dg-rise
              // 420ms), as does the live turn below; a settled answer replacing
              // the live block does NOT re-animate (no flash on complete).
              const idxInSlice = (m: (typeof slice)[number]) => slice.indexOf(m);
              const renderHistoryRowInner = (m: (typeof slice)[number]) => {
              const timeLabel = formatMessageTime(m.createdAt);
              // Minimal view: an inter-agent message is one grey line ("Message from Hyperstack 8xA100").
              const minimalNote = minimalNoteLabel(m.plainMeta);
              if (minimalNote) return <MinimalNoteLine key={m.id} text={minimalNote} />;
              // Machine/system rows (schedule/hook/webhook wakes, inter-agent
              // relays, verifier/watchdog notices) collapse to a one-line
              // expandable system row — Phase C (goal 49dd1b20) + feedback
              // 4959bb1c. COLLAPSE, never filter (the 2026-08-26 filter
              // regression hid real owner messages). origin rides plainMeta
              // (mapPlainMessages); prefix detection needs no metadata. The
              // inline timeLabel replaces this row's corner timestamps.
              const sysKind = m.role === 'user'
                ? classifySystemRow({ role: m.role, content: m.content, metadata: m.plainMeta })
                : null;
              if (sysKind === 'agent') {
                // Agent-to-agent relay (owner ask 2026-09-14): a neutral
                // left card with a "From <sender> · agent" header — never the
                // owner's bubble. sourceChatId rides plainMeta for the link.
                return <AgentMessageCard key={m.id} content={m.content} sourceChatId={m.plainMeta?.sourceChatId} timeLabel={timeLabel ?? undefined} />;
              }
              if (sysKind) {
                return <MachineWakeBlock key={m.id} kind={sysKind} origin={m.plainMeta?.origin} content={m.content} timeLabel={timeLabel ?? undefined} />;
              }
              // Coding-session answer action row (ticket bd5b95b5): null ⇒ the bare stamp line.
              const codingRow = plain ? null : codingActionRowFor({ role: m.role, id: m.id, chatId, isKid, memberViewOnly });
              return (
              // data-nav-msg/data-nav-preview on USER rows feed the right-edge
              // MessageNavigator tick rail (hover preview, click/tap to jump).
              <div key={m.id}
                {...(m.role === 'user' ? { 'data-nav-msg': m.id, 'data-nav-preview': navPreview(m.content) || '(attachment)' } : {})}
                // Inline task card (cohesive chat, 2026-09-28): every row is
                // addressable so a card's "Open result" can jump to the
                // assistant row the result was posted as. The fragment id is
                // the deep link owner-question "Open in chat" uses (#msg-<id>).
                id={`msg-${m.id}`}
                data-msg-id={m.id}
                // Turn anchor (lib/transcript-pin turnAnchorIndex): the follow
                // stops at the newest turn's start row.
                data-row-role={m.role}
                className={cn('group/msg relative flex', m.role === 'user' ? 'justify-end' : 'justify-start', plain && m.role === 'user' && idxInSlice(m) >= slice.length - 2 && 'dg-rise')}>
                {/* Per-message timestamps (ticket 1e6ab89e; owner 2026-09-17
                    "all time stamps should show in the same place which is
                    underneath"): USER rows stamp under the bubble (desktop
                    hover-revealed, mobile always visible). ASSISTANT rows
                    carry NO corner overlay any more — their stamp renders
                    underneath, in the action row (plain chats) or the footer
                    line (coding sessions) below. Skipped when createdAt is
                    missing/invalid. */}
                {timeLabel && (m.role === 'user' ? (
                  <>
                    {/* Desktop: hover-revealed time bottom-right UNDER the bubble,
                        like the chat UI's right-aligned user rows. right-10 (not
                        right-2) leaves room for the copy button on the same line. */}
                    <span className="hidden md:block absolute top-full right-10 mt-0.5 z-10 text-[10px] text-muted-foreground/70 whitespace-nowrap opacity-0 group-hover/msg:opacity-100 transition-opacity">
                      {timeLabel}
                    </span>
                    {/* Mobile: always-visible time under the bubble (no swipe). */}
                    <span className="md:hidden absolute top-full right-10 mt-0.5 text-[10px] text-muted-foreground whitespace-nowrap">
                      {timeLabel}
                    </span>
                  </>
                ) : null)}
                {/* Copy shortcut on the user's own bubble (feedback ticket
                    57542e64): mirrors the assistant row's one-click copy —
                    under the bubble's right edge, on the timestamp line. Only
                    when the message carries text worth copying. */}
                {m.role === 'user' && !!m.content?.trim() && (
                  <UserMessageCopyButton content={m.content} />
                )}
                {m.role === 'user' ? (
                  // min-w-0 is load-bearing: a flex item's min-content width
                  // beats max-w-[80%], so a long unbroken token (API key, URL,
                  // file path) would otherwise overflow the row and make the
                  // whole transcript scroller pan horizontally (whitespace bug).
                  <div className="max-w-[78%] min-w-0 flex flex-col items-end gap-1.5">
                    {m.parts?.filter(p => p.type === 'image' && (p.data || p.url) && p.mediaType).map((p, i) => (
                      <ExpandableDataImage key={i} src={p.url || `data:${p.mediaType};base64,${p.data}`} alt={p.name || 'attached image'} className="max-h-48 max-w-full rounded-xl object-contain" />
                    ))}
                    {/* Plain attachment echo (P2 increment 2): thumbnails/chips
                        like the legacy view's attachmentInfo — echo-only, never
                        persisted (same reload limitation as the legacy view).
                        c6e8edda: persisted chips carrying a fileId render the
                        image INLINE (click-to-expand) via the shared renderer. */}
                    {m.plainMeta?.attachments && m.plainMeta.attachments.length > 0 && (
                      <TranscriptAttachmentChips
                        attachments={m.plainMeta.attachments}
                        variant="bubble"
                        className="flex flex-wrap gap-1.5 justify-end"
                      />
                    )}
                    {(m.content || (!m.parts?.some(p => p.type === 'image') && !m.plainMeta?.attachments?.length)) && (
                      <div className={cn(
                        'rounded-[20px] px-4 py-2.5 text-ink whitespace-pre-wrap [overflow-wrap:anywhere]',
                        // Digby Frontier (2026-10-06): a NEUTRAL bubble (never
                        // violet). Shared-project chats (58ffcf86): a teammate's
                        // message reads distinct — hover bg + a 1px line.
                        isPlainTeammateMessage(m.plainMeta, plain?.viewerId)
                          ? 'bg-hover border border-line'
                          : 'bg-bubble',
                        plainSizes ? plainSizes.userMsg : 'text-sm',
                      )}>{m.content}</div>
                    )}
                    {/* "From: <name>" footnote — only under a teammate's message
                        (58ffcf86 → C2 port); the viewer's own and legacy
                        unstamped rows carry none. Falls back to 'teammate' when
                        the author's name is unresolvable (e.g. deleted account). */}
                    {isPlainTeammateMessage(m.plainMeta, plain?.viewerId) && (
                      <span className="text-[11.5px] text-ink-3">
                        From: {m.plainMeta?.authorName || 'teammate'}
                      </span>
                    )}
                    {/* Queued echoes never reach this list — they are
                        partitioned out above (08d31b1a) and render with their
                        "Queued" caption after the live run block. */}
                  </div>
                ) : (
                  // overflow-x-hidden is load-bearing: the box is capped at 85%,
                  // but WITHOUT clipping, any descendant that visibly overflows
                  // (wide table, oversized image, unbroken token) propagates to
                  // the transcript scroller's scrollWidth and makes the WHOLE
                  // transcript pan horizontally — assistant text then clips at
                  // both viewport edges while shorter rows show right whitespace.
                  <div className={cn('w-full min-w-0 overflow-x-hidden text-sm', plain ? 'dg-answer' : 'md:max-w-[85%]')}>
                    {m.parts?.length ? (plain ? (() => {
                // Parts-bearing plain answers must still surface the email
                // confirm card (regression: raw [SEND_EMAIL] shown, 2026-10-16).
                const { parts: shownParts, emailDraft } = extractEmailFromParts(m.parts, m.content);
                return (
                  <>
                    <AssistantParts parts={shownParts} sizes={plainSizes} hideThinking={hideThinking} foldTail />
                    {emailDraft && <PlainEmailCard draft={emailDraft} />}
                  </>
                );
              })() : <AssistantParts parts={m.parts} sizes={plainSizes} hideThinking={hideThinking} foldTail={!!plain} />) : plain ? (
                      // Plain transcript extras (P2 increment 2): the email
                      // confirm card parses out of [SEND_EMAIL] blocks that
                      // stripForStorage preserved in the content.
                      (() => {
                        const { cleanText, emailDraft } = parseEmailDraft(m.content);
                        return (
                          <>
                            {cleanText && <CodeTranscriptMarkdown text={cleanText} sizes={plainSizes} meta={m.plainMeta} localizeTimes={supervisorChat} statusSuperseded={statusSupersededFor(m)} />}
                            {emailDraft && <PlainEmailCard draft={emailDraft} />}
                          </>
                        );
                      })()
                    ) : <CodeTranscriptMarkdown text={m.content} meta={m.plainMeta} localizeTimes={supervisorChat} statusSuperseded={statusSupersededFor(m)} />}
                    {/* Coding sessions: the message's ONE stamp, underneath (owner 2026-09-17). A persisted
                        assistant answer carries it inside the SAME action row plain chats show — Copy · 👍 ·
                        👎 Report issue · Read aloud, same feedbackApi path (ticket bd5b95b5, lib/coding-feedback.ts). */}
                    {!plain && codingRow && (
                      <PlainMessageActions
                        content={m.content}
                        chatId={codingRow.feedbackChatId}
                        modelSet={m.plainMeta?.modelSet}
                        messageId={codingRow.messageId}
                        isKid={isKid}
                        timeLabel={timeLabel ?? undefined}
                        alwaysVisible={m.id === lastAssistantId}
                      />
                    )}
                    {!plain && !codingRow && timeLabel && (
                      <div data-msg-time className="pt-1 text-[10px] text-muted-foreground/70 whitespace-nowrap tabular-nums select-none md:opacity-0 md:group-hover/msg:opacity-100 transition-opacity">{timeLabel}</div>
                    )}
                    {plain && canvasesByAnswer?.get(m.id)?.map(c => (
                      <CanvasInlineCard key={c.id} title={c.title} type={c.type} onOpen={() => plain.onOpenCanvas?.(c.id)} />
                    ))}
                    {plain && (() => {
                      // Digby Frontier answer footer (2026-10-06): the action
                      // row (Copy · 👍 · 👎 · read aloud · retry) + the ONE
                      // transparency pill (replaces DepthPill + "More info" —
                      // Checking… → Checked by n models / Updated · n
                      // corrections / Quick answer / Check didn't finish ·
                      // Retry, from metadata.check with the legacy fallbacks),
                      // then "How Digby answered" and the follow-up pills with
                      // Dig deeper LAST (latest answer only).
                      const pill = pillFromMeta(m.plainMeta);
                      const howRows = buildHowRows(m.plainMeta, pill, { showModels: !!plain.isAdmin, webSearchConfigured: plain.webSearchConfigured });
                      const howIsOpen = !!howOpen[m.id];
                      const chip = digDeeperChipFor(m);
                      const isLatest = m.id === lastAssistantId;
                      const retryText = (() => {
                        const at = history.findIndex(h => h.id === m.id);
                        for (let i = at - 1; i >= 0; i--) {
                          const h = history[i];
                          if (h.role === 'user' && !classifySystemRow({ role: h.role, content: h.content, metadata: h.plainMeta }) && h.content?.trim()) return h.content;
                          if (h.role === 'user') break;
                        }
                        return null;
                      })();
                      const showFollowUps = isLatest && !live.running && ((m.plainMeta?.followUps?.length ?? 0) > 0 || !!chip);
                      return (
                      <>
                        {m.plainMeta?.corrected && (
                          /* Ticket 318b3175: the streamed text this bubble showed
                              was REPLACED at run finalize (cross-check reconcile,
                              action-guard strike, unbacked-claim rewrite…) — the
                              long answer the owner watched "shrink" into this one.
                              Name the swap so it reads as a correction, not a
                              glitch. Echo-only (the reloaded row never carries it). */
                          <div className="pt-0.5 pb-1 text-[12px] text-ink-3 italic" data-corrected-note>
                            Corrected before delivery — the streamed draft was replaced by the final answer.
                          </div>
                        )}
                        {m.plainMeta?.sources && m.plainMeta.sources.length > 0 && <PlainSourcesRow sources={m.plainMeta.sources} showScores={!!plain.isAdmin} />}
                        <PlainMessageActions
                          content={m.content}
                          chatId={chatId ?? ''}
                          modelSet={m.plainMeta?.modelSet}
                          messageId={CROSSMODEL_MSG_ID_RE.test(m.id) ? m.id : undefined}
                          isKid={isKid}
                          timeLabel={timeLabel ?? undefined}
                          alwaysVisible={isLatest}
                          onRetry={retryText && !live.running && !memberViewOnly ? () => void send(retryText) : undefined}
                          trailing={!isKid && !minimal ? (
                            <TransparencyPill
                              state={pill}
                              seats={howRows.length}
                              open={howIsOpen}
                              onToggle={() => setHowOpen(o => ({ ...o, [m.id]: !o[m.id] }))}
                              onRetry={chip?.kind === 'escalate' ? () => void send(undefined, undefined, { escalationOf: chip.escalationOf }) : undefined}
                            />
                          ) : undefined}
                        />
                        {howIsOpen && !isKid && !minimal && (
                          <HowDigbyAnswered
                            rows={howRows}
                            state={pill}
                            previousContent={m.plainMeta?.revision?.previousContent}
                            currentContent={m.content}
                            renderDetail={plain.isAdmin ? (r) => <PlainModelCard label={r.name} response={r.response as Parameters<typeof PlainModelCard>[0]["response"]} /> : undefined}
                          />
                        )}
                        {/* Digby Kids web-search cue (C3 kid flip, design D5):
                            the friendly "I checked the web" line the legacy
                            transcript shows kids instead of the technical
                            footer — same metadata key, same isKid source. */}
                        {isKid && !!(m.plainMeta?.models as any)?.qwen_kid?.webSearchUsed && (
                          <div className="pt-2 pb-1">
                            <span className="inline-flex items-center gap-1 text-[12px] text-ink-3">🔎 I looked it up on the web to be sure!</span>
                          </div>
                        )}
                        {/* Follow-ups (latest answer only) with the single "Dig
                            deeper" control (or the guest's sign-in affordance)
                            as the LAST pill — server chips win, a reloaded row
                            derives the next rung from its depth plan. A tap
                            prefills the composer (never auto-sends). */}
                        {showFollowUps && (
                          <PlainFollowUps
                            followUps={m.plainMeta?.followUps ?? []}
                            disabled={live.running}
                            onPick={(q) => { composerRef.current?.setValue(q); composerRef.current?.focus(); }}
                            trailing={
                              <DepthChipRow
                                inline
                                chip={chip}
                                quota={plain.deepResearchQuota}
                                disabled={live.running}
                                onEscalate={(escalationOf) => { sendUxBeacon({ event: 'tap', target: 'escalate', chatId: chatId ?? undefined, messageId: escalationOf, mode: plain.mode }); void send(undefined, undefined, { escalationOf }); }}
                                onSigninDeeper={() => { sendUxBeacon({ event: 'tap', target: 'signin_deeper', sessionId: plain.guestSessionId, mode: plain.mode }); }}
                              />
                            }
                          />
                        )}
                      </>
                      );
                    })()}
                  </div>
                )}
              </div>
              );
              };
              const grouped = groupMachineRows(slice, {
                probe: (m) => ({ id: m.id, role: m.role, content: m.content, origin: m.plainMeta?.origin, kind: m.plainMeta?.kind, ownerArmed: m.plainMeta?.scheduleOwnerArmed === true,
                  // Ticket 56d6b204: a child→parent result-hook wake — the
                  // anchor row's metadata.childResult (chat-agent stamps it
                  // when hooks.service fires the auto-wired sub-session
                  // result) mounts the turn EXPANDED so the delivered result
                  // is never hidden behind the collapsed machine pill.
                  childResult: m.plainMeta?.childResult === true,
                  // Fixer 2026-09-27 (finding upward-chatter-1): an owner-ask
                  // re-wake / nudge — the anchor row's metadata.ownerAskReply
                  // mounts the turn EXPANDED so the answer the owner asked for
                  // is never hidden behind the collapsed machine pill.
                  ownerAskReply: m.plainMeta?.ownerAskReply === true,
                  // Ticket 390b6767: signals the content scan cannot see — an
                  // assistant image part (screenshots/generated images) or an
                  // attachment chip with a resolved fileId renders inline, so
                  // the group mounts expanded instead of hiding the image
                  // behind the collapsed machine pill.
                  carriesImage: !!m.parts?.some(p => p.type === 'image')
                    || !!m.plainMeta?.attachments?.some(a => !!a.fileId && (a.type === 'image' || (a.mimeType || '').startsWith('image/'))) }),
                timeOf: (m) => formatMessageTime(m.createdAt) ?? undefined,
              });
              const renderGroup = (item: MachineTurnGroupItem<(typeof slice)[number]>) => (
                <MachineTurnGroup key={item.key} count={item.count} summary={item.summary} headline={item.headline} timeLabel={item.timeLabel}
                  // Owner-armed digest (ticket 6ef770a1): the group's anchor wake
                  // row carries metadata.scheduleOwnerArmed — mount EXPANDED and
                  // mark "requested" so the owner's own scheduled content (the
                  // ~7:30 AM AI digest) is readable without a click, visually
                  // distinct from internal wake noise.
                  ownerArmed={item.ownerArmed}
                  // Ticket 56d6b204: a child→parent result-hook wake mounts
                  // EXPANDED + "results" chip — the sub-session's delivered
                  // verdict is content the owner is waiting on, never noise
                  // to fold behind the collapsed pill.
                  childResult={item.childResult}
                  // Fixer 2026-09-27: an owner-ask wake mounts EXPANDED +
                  // "answer" chip — the reply the owner asked for.
                  ownerAskReply={item.ownerAskReply}
                  // Ticket 390b6767: a delivered inline image mounts the group
                  // expanded + "image" chip — never folded out of sight.
                  hasImage={item.hasImage}>
                  {item.rows.map(r => renderHistoryRow(r))}
                </MachineTurnGroup>
              );
              // Owner 2026-09-29 ("hide a lot more machine messages"): in a
              // supervisor chat, consecutive background wakes fold into ONE
              // "background check-ins" row (bundleMachineGroups); it expands to
              // the per-wake pills above. Other chats keep per-wake pills.
              // Minimal view: the server already removed machine turns — every remaining row renders as itself,
              // except a stretch of "Message from …" notes, which is ONE line (owner 2026-10-21).
              if (minimal) {
                return groupMinimalNotes(slice, row => row.plainMeta, row => row.id).map(item => item.kind === 'notes'
                  ? <MinimalNoteLine key={item.key} text={item.text} title={item.title} />
                  : renderHistoryRow(item.row));
              }
              const items = supervisorChat ? bundleMachineGroups(grouped) : grouped;
              return items.map(item => item.kind === 'machineBundle' ? (
                <MachineBundle key={item.key} groups={item.groups.length} firstTime={item.firstTime} lastTime={item.lastTime} attention={item.attention} agentMessages={item.agentMessages} latest={item.latest}>
                  {item.groups.map(g => renderGroup(g))}
                </MachineBundle>
              ) : item.kind === 'machineGroup' ? renderGroup(item) : renderHistoryRow(item.row));
            })()}

            {/* Live run */}
            {live.running && (
              <div className={cn('w-full min-w-0 overflow-x-hidden text-sm', plain ? 'dg-answer dg-rise' : 'md:max-w-[85%]')}>
                {/* Plain chats fold the LIVE tool run too (owner 2026-09-15 — the
                    ~30-row wall above the Double Checker chip); coding sessions
                    keep their expanded live edge (follow-along contract). */}
                <StreamingWordsContext.Provider value={!!plain}>
                  {/* quietLiveTail (owner 2026-10-07 "a lot going on"): the live
                      tool run is not drawn above the Thinking block / status
                      line — ONE status surface; the settled row keeps the fold. */}
                  <AssistantParts parts={liveRenderParts} sizes={plainSizes} hideThinking={hideThinking} foldTail={!!plain} quietLiveTail={!!plain} />
                </StreamingWordsContext.Provider>
                {/* Worker chips are a CODING surface (delegated helpers). In
                    plain chats the seat lifecycle already reads from the folded
                    tool-activity header ("Digby + Double Checker · Working …")
                    and the status line — a third concurrent surface was the
                    audit's top clutter finding (2026-09-15). */}
                {!plain && !minimal && live.workers && live.workers.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 my-1.5">
                    {live.workers.map((w, i) => (
                      <span key={i} className={cn('inline-flex items-center gap-1 rounded-full border border-line bg-raised px-2.5 py-0.5 text-[11.5px]',
                        w.done ? 'text-ink-3' : 'text-ink-2')}>
                        {w.done ? <Check className="size-3 text-ok" /> : <Loader2 className="size-3 animate-spin" />}
                        <Users className="size-2.5" />{w.role}{w.title && w.title !== w.role ? ` · ${w.title}` : ''}
                      </span>
                    ))}
                  </div>
                )}
                {live.verify && !minimal && (
                  <div className="flex flex-wrap items-center gap-1.5 my-1.5 text-[11px]">
                    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-raised px-2.5 py-0.5 text-ink-3">
                      {live.verify.running ? <Loader2 className="size-2.5 animate-spin" /> : <CheckCheck className="size-2.5" />}
                      verify
                    </span>
                    {live.verify.stages.map((s, i) => (
                      <span key={i} className={cn('inline-flex items-center gap-1 rounded-full border bg-raised px-2.5 py-0.5',
                        live.verify!.running ? 'border-line text-ink-3'
                          : s.passed ? 'border-line text-ink-2'
                          : 'border-destructive/40 text-destructive')}>
                        {!live.verify!.running && (s.passed ? <Check className="size-3 text-ok" /> : <X className="size-3" />)}
                        {s.key}
                      </span>
                    ))}
                  </div>
                )}
                {/* Depth UX (2026-09-26): the streaming turn's check pill (a
                    'checking' / early 'checked' state the harness emitted before
                    complete); the appended bubble takes over via plainMeta.check. */}
                {plain && live.check && <DepthPill state={pillFromMeta(undefined, live.check)} />}
                {/* Plain chats (Digby Frontier): before the first token the
                    "Thinking" block (hat + shimmer + the progress steps);
                    once text streams, a pulsing dot trails the words.
                    Coding sessions keep the status row + run clock
                    (LiveRunStatus leaf; a polled guest resume has no
                    runStart, so it renders the calm line alone). */}
                {minimal && !live.pendingApproval
                  ? <LiveRunStatus stopping={live.stopping} status="Working…" since={runStart} />
                  : plain && !live.pendingApproval
                  ? (liveHasText(liveRenderParts)
                    ? <StreamingDot stopping={live.stopping} status={live.status} />
                    : <ThinkingBlock steps={live.steps} status={live.status} stopping={live.stopping} since={runStart} />)
                  : !live.pendingApproval && <LiveRunStatus stopping={live.stopping} status={live.status} since={runStart} />}
                {live.pendingApproval && (
                  <div className="dg-pop rounded-[14px] border border-line bg-raised shadow-(--shadow) p-3.5 mt-2 font-sans">
                    <div className="text-[13px] font-medium mb-1.5 flex items-center gap-1.5 text-ink"><ShieldCheck className="size-3.5 text-warn" /> {minimal ? 'Digby wants to go ahead with the next step. Allow it?' : <>Approve {live.pendingApproval.tool}?</>}</div>
                    {!minimal && <pre className="text-[11.5px] font-mono bg-bg-2 border border-line rounded-lg p-2 overflow-x-auto max-h-40 mb-2.5 text-ink-2">{JSON.stringify(live.pendingApproval.args, null, 2)}</pre>}
                    <div className="flex gap-2">
                      <button onClick={() => respondApproval('allow')} className="flex items-center gap-1 text-[12.5px] font-medium bg-send text-send-ink rounded-full px-3 py-1.5 active:scale-[0.97] transition"><Check className="size-3.5" /> Allow</button>
                      <button onClick={() => respondApproval('always')} className="text-[12.5px] border border-line text-ink-2 rounded-full px-3 py-1.5 hover:bg-hover hover:border-line-2 transition-colors">Always</button>
                      <button onClick={() => respondApproval('deny')} className="flex items-center gap-1 text-[12.5px] border border-line text-ink-2 rounded-full px-3 py-1.5 hover:bg-hover hover:border-line-2 hover:text-destructive transition-colors"><X className="size-3.5" /> Deny</button>
                    </div>
                  </div>
                )}
                {live.pendingQuestion && (
                  /* The ask_user card (Digby Frontier, 2026-10-06 sweep — owner:
                     "did you not fix the Q&A?"). The question is chat content, so
                     it renders as MARKDOWN in the chat's own typography (bullets,
                     bold, code — never a pre-wrapped wall of text); the countdown
                     is quiet ink-3 until the last minute; the answer box is the
                     composer's language (rounded field + send circle, Enter sends,
                     Shift+Enter breaks a line, grows to 160px). */
                  <div data-question-card className="dg-pop mt-3 overflow-hidden rounded-[20px] border border-line bg-raised font-sans shadow-(--shadow)">
                    <div className="flex items-center gap-2 px-4 pt-3.5 pb-1">
                      <HelpCircle className="size-4 shrink-0 text-ink-3" />
                      <span className="text-[13.5px] font-medium text-ink">Digby needs your input</span>
                      {questionRemainMs != null && questionRemainMs > 0 && (
                        <span data-question-countdown className={cn('ml-auto text-[12px] tabular-nums', questionRemainMs <= 60_000 ? 'text-destructive' : 'text-ink-3')}>
                          {questionRemainMs <= 60_000 ? 'Closing in' : 'Answers close in'} {fmtQuestionCountdown(questionRemainMs)}
                        </span>
                      )}
                    </div>
                    <div className="dg-answer max-h-[45vh] overflow-y-auto px-4 pb-1 [&_p:last-child]:mb-0">
                      <CodeTranscriptMarkdown text={live.pendingQuestion.question} sizes={plainSizes} />
                    </div>
                    {live.pendingQuestion.options.length > 0 && !live.pendingQuestion.optionDetails && !live.pendingQuestion.multiSelect && (
                      <div className="flex flex-wrap gap-1.5 px-4 pt-2">
                        {live.pendingQuestion.options.map((opt, i) => (
                          <button key={i} onClick={() => answerQuestion(opt)}
                            className="min-h-8 rounded-full border border-line bg-raised px-3.5 py-1 text-[13px] text-ink-2 transition-colors hover:border-line-2 hover:bg-hover hover:text-ink">{opt}</button>
                        ))}
                      </div>
                    )}
                    {/* Directions with a one-line description each (creative-direction asks) and / or a multi-pick
                        question: a list of rows. Single pick answers on click; multi-pick toggles, then the send
                        button below sends the picks (+ anything typed). */}
                    {live.pendingQuestion.options.length > 0 && (live.pendingQuestion.optionDetails || live.pendingQuestion.multiSelect) && (
                      <div data-question-options className="flex flex-col gap-1.5 px-4 pt-2">
                        {(live.pendingQuestion.optionDetails ?? live.pendingQuestion.options.map(label => ({ label, description: undefined as string | undefined }))).map((opt, i) => {
                          const multi = !!live.pendingQuestion?.multiSelect;
                          const on = multi && questionPicks.has(opt.label);
                          return (
                            <button key={i} type="button" aria-pressed={multi ? on : undefined}
                              onClick={() => {
                                if (!multi) { answerQuestion(opt.label); return; }
                                setQuestionPicks(prev => { const next = new Set(prev); if (next.has(opt.label)) next.delete(opt.label); else next.add(opt.label); return next; });
                              }}
                              className={cn('flex items-start gap-2.5 rounded-[14px] border px-3.5 py-2 text-left transition-colors',
                                on ? 'border-ink-2 bg-hover' : 'border-line bg-raised hover:border-line-2 hover:bg-hover')}>
                              {multi && (
                                <span className={cn('mt-[3px] flex size-4 shrink-0 items-center justify-center rounded-[5px] border', on ? 'border-send bg-send text-send-ink' : 'border-line-2')}>
                                  {on && <Check className="size-3" strokeWidth={3} />}
                                </span>
                              )}
                              <span className="min-w-0">
                                <span className="block text-[13.5px] font-medium text-ink">{opt.label}</span>
                                {opt.description && <span className="block text-[12.5px] leading-snug text-ink-3">{opt.description}</span>}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                    <div className="p-2.5 pt-3">
                      <div className="flex items-end gap-2 rounded-[18px] border border-line bg-background py-1.5 pl-4 pr-1.5 transition-colors focus-within:border-line-2">
                        <textarea
                          rows={1}
                          value={questionDraft}
                          onChange={e => setQuestionDraft(e.target.value)}
                          onInput={e => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 160)}px`; }}
                          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (questionAnswer.trim()) answerQuestion(questionAnswer); } }}
                          placeholder={live.pendingQuestion.multiSelect ? 'Pick any above, or add a note…' : live.pendingQuestion.options.length ? 'Or type your own answer…' : 'Type your answer…'} autoFocus aria-label="Your answer"
                          className="max-h-40 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-[1.5] text-ink outline-none placeholder:text-ink-3" />
                        <button onClick={() => answerQuestion(questionAnswer)} disabled={!questionAnswer.trim()}
                          aria-label="Send answer" title="Send answer" className={cn(SEND_BTN, 'size-8')}>
                          <ArrowUp className="size-4" strokeWidth={2.25} />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                {/* Sponsored slot — under the status line AND any input card
                    (approval / question) while the run streams (audit
                    2026-09-15: an ad between the status and a card asking the
                    user something buried the ask). Mounts/unmounts with this
                    live-run card, so each run requests a fresh ad and the GPT
                    slot is destroyed when the run finishes. Gated on !isKid
                    (COPPA) — same audience rule as the chat surface. */}
                {!isKid && <ThinkingAd />}
              </div>
            )}

            {/* Inline staged-confirmation cards (ticket cbdb4614) — DB-persisted
                consequential-tool confirmations staged by THIS chat, fed by the
                host page's 20s /confirmations/pending poll (already chat-scoped
                and liveness-filtered). In-flow at the transcript bottom so the
                card renders where the user is looking, run-active or not —
                these previously surfaced ONLY in the collapsed sidebar rail /
                Management inbox, so a user watching the conversation (the rail
                is behind a drawer on mobile) could truthfully report never
                seeing a confirm card. Same one-shot server consume as the rail
                card: the host handler confirms/cancels, toasts, and refreshes
                the poll, which unmounts the card. */}
            {pendingChatConfirmations && pendingChatConfirmations.length > 0 && (
              <div className="space-y-2 mt-2">
                {pendingChatConfirmations.map((p) => (
                  <div key={p.id} className="dg-pop rounded-[14px] border border-line bg-raised shadow-(--shadow) p-3.5 font-sans">
                    <div className="text-[13px] font-medium mb-1.5 flex items-center gap-1.5 text-ink"><ShieldCheck className="size-3.5 text-warn" /> Confirm this action?</div>
                    <p className="text-[13.5px] leading-relaxed mb-2.5 whitespace-pre-wrap text-ink-2">{p.question}</p>
                    <div className="flex gap-2">
                      <button onClick={() => onResolvePendingConfirmation?.(p, 'confirm')} className="flex items-center gap-1 text-[12.5px] font-medium bg-send text-send-ink rounded-full px-3 py-1.5 active:scale-[0.97] transition"><Check className="size-3.5" /> Confirm</button>
                      <button onClick={() => onResolvePendingConfirmation?.(p, 'cancel')} className="flex items-center gap-1 text-[12.5px] border border-line text-ink-2 rounded-full px-3 py-1.5 hover:bg-hover hover:border-line-2 transition-colors"><X className="size-3.5" /> Cancel</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* Owner 2026-09-22: flagged owner questions for THIS chat, in-flow and
                answerable — the flagger's options as buttons, honest triage line. */}
            {pendingOwnerQuestions && pendingOwnerQuestions.length > 0 && onAnswerOwnerQuestion && (
              <div className="space-y-2 mt-2" data-owner-questions-inflow>
                {pendingOwnerQuestions.map((p) => (
                  <OwnerQuestionCard key={p.id} p={p} onAnswer={onAnswerOwnerQuestion} onDismiss={onDismissOwnerQuestion} onOpenInbox={onOpenInbox} />
                ))}
              </div>
            )}

            {/* Queued echoes (08d31b1a) — IN-FLOW at the bottom of the
                transcript, AFTER the live run block and before the composer:
                the live block above can grow thousands of px tall, so an echo
                rendered at its array position landed at the live block's top
                edge, far above the pinned viewport (the "queued messages appear
                very high up" bug). Here the bubble lands exactly where the user
                is looking — PR #328's core goal (3d6a8cb2) is preserved: the
                echo is ALWAYS visible, captioned queued until the run ends;
                this is NOT the pre-#328 floating overlay, it flows with the
                transcript. Same user-bubble styling + images/attachment chips
                as the history rows, plus an always-visible send time (desktop
                AND mobile — deliberately not the hover-only pattern: the bubble
                is transient, so its stamp is the proof it landed in the queue).
                On run complete pendingSteerIds clears and the server-persisted
                steer row takes its true chronological slot via reloadSession —
                the `steer-*`/`tmp-*` echo ids never collide with server ids. */}
            {queuedEchoes.map(m => {
              const timeLabel = formatMessageTime(m.createdAt);
              // Send-while-provisioning echoes (lib/provision-queue.ts) carry
              // their own caption whatever the run state: nothing runs yet.
              // Guest mid-run holds (lib/guest-send-queue.ts, d0777a67) too.
              const provisionQueued = isProvisionQueueId(m.id);
              const guestQueued = isGuestQueueId(m.id);
              return (
              <div key={m.id} className="flex justify-end">
                {/* min-w-0 is load-bearing here too — see the history user row. */}
                <div className="max-w-[80%] min-w-0 flex flex-col items-end gap-1.5">
                  {m.parts?.filter(p => p.type === 'image' && (p.data || p.url) && p.mediaType).map((p, i) => (
                    <ExpandableDataImage key={i} src={p.url || `data:${p.mediaType};base64,${p.data}`} alt={p.name || 'attached image'} className="max-h-48 max-w-full rounded-lg object-contain" />
                  ))}
                  {m.plainMeta?.attachments && m.plainMeta.attachments.length > 0 && (
                    <TranscriptAttachmentChips
                      attachments={m.plainMeta.attachments}
                      variant="bubble"
                      className="flex flex-wrap gap-1.5 justify-end"
                    />
                  )}
                  {(m.content || (!m.parts?.some(p => p.type === 'image') && !m.plainMeta?.attachments?.length)) && (
                    <div className={cn('rounded-[20px] bg-bubble text-ink px-4 py-2.5 whitespace-pre-wrap [overflow-wrap:anywhere]', plainSizes ? plainSizes.userMsg : 'text-sm')}>{m.content}</div>
                  )}
                  <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-3">
                    {provisionQueued ? (
                      <>
                        <DigbyLoader size={16} label="Queued" /> {PROVISION_QUEUE_CAPTION}
                      </>
                    ) : guestQueued ? (
                      <>
                        <DigbyLoader size={16} label="Queued" /> {GUEST_QUEUE_CAPTION}
                      </>
                    ) : live.running && (
                      <>
                        <DigbyLoader size={16} label="Queued" /> {plain ? 'Queued — runs when this turn finishes' : 'Queued — folds into the run at its next step'}
                      </>
                    )}
                    {timeLabel && (
                      <span className="text-ink-3 whitespace-nowrap">{live.running || provisionQueued || guestQueued ? `· ${timeLabel}` : timeLabel}</span>
                    )}
                  </span>
                </div>
              </div>
              );
            })}

          </div>
          </div>
          {/* Right-edge message-navigator rail (kimi-style): one tick per user
              message, hover for the first words, click/tap to jump there. */}
          <MessageNavigator scrollerRef={scrollRef} contentRef={transcriptContentRef} />
          {showJumpToEnd && (
            <button onClick={jumpToEnd}
              className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 rounded-full border border-border bg-background/95 backdrop-blur px-3 py-1 text-xs shadow-md hover:bg-muted animate-in fade-in slide-in-from-bottom-1">
              <ChevronDown className="size-3.5" /> Jump to latest
            </button>
          )}
          {/* Browser program (Phase 6a) — mobile reopen pill: browser activity
              exists but the sheet is closed (dismissed or landed mid-run).
              md:hidden — desktop uses the workspace panel's Browser tab. */}
          {browserActivity.entries.length > 0 && !browserSheet.open && (
            <button
              onClick={() => setBrowserSheet(s => nextBrowserSheetState(s, 'open'))}
              className="absolute bottom-3 right-3 z-10 md:hidden flex items-center gap-1.5 rounded-full border border-border bg-background/95 backdrop-blur px-3 py-1.5 text-xs shadow-md animate-in fade-in"
              aria-label="Show agent browser"
            >
              <Globe className={cn('size-3.5 text-ink-3', live.running && 'animate-pulse')} />
              <span className="max-w-40 truncate">{browserPageLabel(browserActivity)}</span>
            </button>
          )}
        </div>

        {/* Composer — the shared ChatComposer (P4); the session header is gone
            (branch/publish/agent-mode live in the host's floating ⋯ menu), so
            steer-while-running is expressed via the isStreaming/submitPending
            props. The composer sits at the bottom of the scrolling transcript,
            so the hard top border is replaced by the same soft gradient fade
            (before:) as the main chat composer: transcript content melts into
            the composer area instead of being hard-clipped. Image attachments
            (#65) ride the topContent / leftActions / hiddenFileInput slots. */}
        {/* Bottom padding (owner 2026-09-17 "on the phone layout there is no
            air to breathe under the input box"): the 2026-09-16 zero-padding
            rule was a misdiagnosis — the white band it targeted was the
            status-bar-sized web view (fixed by the 'default' status-bar
            style), not this pad. Mobile now breathes: the larger of 0.5rem,
            the home-indicator inset and the shell overflow; desktop keeps the
            p-3 rhythm. */}
        <div
          data-composer
          // Classes, not an inline style: an inline paddingBottom overrode
          // the desktop pad and the pill sat flush on the window edge
          // (owner 2026-09-16 "looks funny without any spacing underneath").
          // Digby Frontier: a 36px fade melts the transcript into the
          // composer; 14px of air below on desktop.
          className="relative bg-background px-4 sm:px-6 pt-0 pb-[max(0.5rem,env(safe-area-inset-bottom,0px),var(--app-overflow,0px))] sm:pb-[max(14px,var(--app-overflow,0px))] shrink-0 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-9 before:bg-gradient-to-t before:from-background before:to-transparent"
        >
          {/* Same reading measure as the transcript above (P2 item 1). */}
          <div className="mx-auto w-full max-w-(--measure-chat)">
          {/* Queued-message controls (ticket ea04454c): the owner's own waiting
              messages, in drain order, each with position + reorder + run-now +
              cancel. Renders nothing when the queue is empty. */}
          {!!chatId && !memberViewOnly && (
            <QueuedMessagesPanel
              items={queueItems}
              running={live.running}
              busy={queueBusy}
              onMove={moveQueued}
              onRunNow={(id) => void runQueuedNow(id)}
              onCancel={cancelQueued}
            />
          )}
          <ChatComposer
            variant="code"
            // Enter semantics: device-aware default for BOTH session kinds
            // (2026-09-14, ticket 67fc53a7) — desktop Enter sends, Shift+Enter
            // newline; touch Enter = newline. (Was: plain chats forced
            // newline-always, coding forced send-always.)
            composerRef={composerRef}
            onSubmit={() => {
              if (memberViewOnly) return; // 7acaa7ba: members watch; the owner runs
              // Ticket b54efe5d: the send circle has ONE meaning — queue behind
              // the live answer (plain; a guest holds it client-side) / steer
              // the live run (coding). Interrupting is its own small button
              // (onInterrupt below), so the circle never changes meaning
              // between sends.
              if (live.running) {
                if (plain) void send();
                else void steer();
                return;
              }
              void send();
            }}
            /* Ticket b54efe5d: interrupting is a SMALL gesture beside the send
               circle, offered only where it can work (a signed-in chat queue on
               the plain surface, a live session on the coding one). Plain chats
               ride send()'s queue→promote→stop path; a coding run stops first,
               waits for the session to settle, then sends the draft as its own
               turn (see interruptWithMessage). */
            {...(!memberViewOnly && (plain ? !!chatId : !!activeSession)
              ? { onInterrupt: () => { if (plain) void send(undefined, undefined, { interrupt: true }); else void interruptWithMessage(); } }
              : {})}
            onEmptyChange={(empty) => setHasText(!empty)}
            onPaste={(e) => {
              if (plainRef.current) {
                // Plain attachments (P2 increment 2): pasted images route to the
                // page's upload flow (legacy paste is images-only — parity).
                const pastedImgs = Array.from(e.clipboardData?.items || []).filter(it => it.type.startsWith('image/'));
                if (!pastedImgs.length) return;
                e.preventDefault();
                plainRef.current.onAttachFiles?.(pastedImgs.map(it => it.getAsFile()).filter((f): f is File => !!f));
                return;
              }
              // Paste-to-attach (#65) — ALL models: text-only sessions get
              // describe-and-inject server-side (same contract as the
              // paperclip/drop path), so never refuse. Say so honestly (per
              // gesture) when the model itself won't see the pixels.
              const pasted = Array.from(e.clipboardData?.items || []).filter(it => it.type.startsWith('image/'));
              if (!pasted.length) return;
              e.preventDefault();
              addImageFiles(pasted.map(it => it.getAsFile()).filter((f): f is File => !!f));
              if (!minimal && !modelSupportsVision(activeSession?.model)) {
                toast.info('Attached — Digby will describe the image for this text-only model', { description: 'For native vision, switch the coding model to Digby or DeepSeek V4.1 Flash (Account → Coding).' });
              }
            }}
            // d0777a67: a GUEST mid-run send is queueable (the client-side guest
            // queue) — the hold only applies to the authed chatless fallback.
            canSubmit={!memberViewOnly && ((hasText || pendingImages.length > 0 || pendingUploads.length > 0 || (plain ? !!plain.hasAttachments : false)) && !(plain && !chatId && !plain.guest && live.running))}
            // No depth control in the composer (roster 2026-10-06 B-3: the plain picker slot is gone — Digby picks
            // depth and models per message); coding sessions keep permission mode in the ⋯ menu. The mic stays.
            rightActions={(<>
              {/* Mic — voice input (0c256c3a): same shared hook as plain chat.
                  Rendered in the desktop shell too (2026-10-20: one UI for
                  chats and coding sessions; the tap goes to the native
                  recorder over the dictation bridge — 00504a77 keeps the web
                  recorder off there). Digby Frontier: a 34px ghost circle on
                  the right, before Send. */}
              <button type="button"
                onClick={voice.toggleRecording}
                disabled={voice.isTranscribing}
                className={voice.isRecording
                  ? cn(COMPOSER_TOOL_BTN, 'text-destructive bg-destructive/10 dark:bg-destructive/15 animate-pulse')
                  : COMPOSER_TOOL_BTN}
                title={voice.isTranscribing ? 'Transcribing…' : voice.isRecording ? 'Stop recording' : 'Voice input'}
                aria-label={voice.isTranscribing ? 'Transcribing' : voice.isRecording ? 'Stop recording' : 'Voice input'}>
                {voice.isTranscribing ? <Loader2 className="size-4 animate-spin" /> : voice.isRecording ? <MicOff className="size-[17px]" strokeWidth={1.75} /> : <Mic className="size-[17px]" strokeWidth={1.75} />}
              </button>
            </>)}
            // Plain send never steers — while streaming it QUEUES (busy-queue
            // passthrough), so don't show the coding variant's steer tooltip.
            // Ticket b54efe5d: "send now" is no longer a mode on this circle —
            // interrupting has its own small button (onInterrupt above).
            submitTitle={plain ? (live.running
              ? (chatId ? 'Queue message' : (plain.guest ? 'Queue message' : 'Wait for this answer…'))
              : 'Send message') : undefined}
            submitPending={steering}
            isStreaming={composerRun.streaming}
            onStop={composerRun.streaming ? () => void stopRun() : undefined}
            stopDisabled={live.stopping}
            stopPending={live.stopping}
            // Owner 2026-09-17: the placeholder is the INVITATION only — never a
            // status line ("we don't want text in the placeholder input … that
            // message should only display below"). Every status truth (2026-08-28
            // "a ton of waiting for the worktree": running / attaching / error /
            // provisioning) renders in footerNote below the pill, one place, one
            // voice. Voice and drag keep their momentary cues.
            placeholder={voice.isRecording ? '🎤 Listening… speak now'
              : dragOver ? (plain ? '📎 Drop files here…' : '📎 Drop files to attach — images, text/code, or PDF/DOCX/XLSX…')
              : plain ? (messages.length === 0 && !live.running ? 'How can I help today?' : 'Reply to Digby…')
              : 'Describe what to build or fix…'}
            dragOver={dragOver}
            dragHandlers={{
              onDragOver: e => { e.preventDefault(); setDragOver(true); },
              onDragEnter: e => { e.preventDefault(); setDragOver(true); },
              onDragLeave: () => setDragOver(false),
              onDrop: e => {
                e.preventDefault(); e.stopPropagation();
                setDragOver(false);
                if (!e.dataTransfer.files.length) return;
                // Plain mode routes drops to the page's upload flow (P2
                // increment 2); coding keeps the image/inline router.
                if (plainRef.current) plainRef.current.onAttachFiles?.(Array.from(e.dataTransfer.files));
                else handleIncomingFiles(e.dataTransfer.files);
              },
            }}
            topContent={plain ? (plain.attachmentsBar ?? undefined) : pendingImages.length > 0 || pendingUploads.length > 0 || imageNote ? (
              <>
                {pendingImages.length > 0 && (
                  <div className="flex flex-wrap gap-2 pb-2">
                    {pendingImages.map((img, i) => (
                      <div key={i} className="relative">
                        <img src={img.previewUrl} alt={img.name || 'attached image'} className="size-12 rounded-md object-cover border border-border" />
                        <button type="button" onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                          className="absolute -top-1.5 -right-1.5 rounded-full bg-foreground text-background size-4 text-[10px] leading-none flex items-center justify-center" title="Remove image">×</button>
                      </div>
                    ))}
                  </div>
                )}
                {/* 7b5ee09b: staged document chips (PDF/DOCX/XLSX) — the SAME
                    shared chip bar the plain-chat composer renders. */}
                {pendingUploads.length > 0 && (
                  <div className="pb-2">
                    <AttachmentChips attachments={pendingUploads} onRemove={(i) => setPendingUploads(prev => prev.filter((_, j) => j !== i))} />
                  </div>
                )}
                {imageNote && <p className="text-[10px] text-warn-ink pb-1">{imageNote}</p>}
              </>
            ) : undefined}
            leftActions={(<>
              {/* Never `disabled`: a disabled button swallows the click AND its own
                  tooltip on Chromium — that silent dead-click was the 2026-08-09
                  user report. The picker always opens (2026-08-14: it used to no-op
                  with only a toast on non-vision models); images attach per-file,
                  text/code files inline into the draft, and PDF/DOCX/XLSX documents
                  stage through the shared upload channel (7b5ee09b).
                  Plain mode (P2 increment 2): the page's upload flow accepts ALL
                  file types — no vision gate. */}
              {/* Ticket 625773b5 (owner report): GUESTS get the paperclip too.
                  The C3 "no attachments for guests" gate is lifted — the open
                  /crossmodel/upload route has always accepted anonymous
                  callers (optionalAuthenticate → ownerUserId null) and the
                  chatless /stream send carries uploadId params, so nothing
                  about the posture was backend-enforced. */}
              <button type="button"
                onClick={() => fileInputRef.current?.click()}
                className={COMPOSER_ATTACH_BTN}
                title={plain ? 'Add files' : 'Add files — images, text/code files, or PDF/DOCX/XLSX documents'}
                aria-label="Attach files">
                <Plus className="size-[17px]" strokeWidth={1.75} />
              </button>
              {/* Ghost mode (2026-10-22) — the ONE ghost toggle beside the
                  composer (integ/ghost-composer: #1897's signed-in toggle and
                  the feat/ghost-composer-toggle branch merged into this one
                  site; the home composer's "arm the next new chat" twin lives
                  in page.tsx and renders the same GhostComposerToggle at the
                  same spot, after +). The page wires plain.onToggleGhost:
                  - GUESTS: flips the browser-local per-session flag
                    (ghost=true rides every chatId-less send). Guests get the
                    + attach button too (625773b5), so the toggle sits beside
                    it.
                  - SIGNED-IN, the owner's own PLAIN chat with a known posture
                    (lib/ghost-composer.ts ghostToggleTarget — never coding
                    sessions, supervisor chats / lanes, kids or other people's
                    chats; NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED=1 hides
                    it): flips the chat row's ghostMode (PUT /chats/:id), and
                    the side-panel Settings switch follows it. The view's own
                    transcript read is the second gate: a row built outside the
                    list may lack isProjectSupervisor, the transcript GET never
                    does, so the signed-in toggle waits for it (plainLoaded)
                    and never shows on a supervisor chat.
                  Orthogonal to depth — a plain on/off toggle, never a mode
                  picker. The pressed state doubles as the persistent
                  indicator; the header badge carries the tooltip. */}
              {plain?.onToggleGhost && (plain.guest || (plainLoaded && !supervisorChat)) && (
              <GhostComposerToggle on={!!plain.ghost} busy={!!plain.ghostSaving} onToggle={plain.onToggleGhost} />
              )}
            </>)}
            hiddenFileInput={plain ? (
              <input ref={fileInputRef} type="file" multiple
                aria-hidden="true" tabIndex={-1}
                className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
                onChange={e => { if (e.target.files?.length) plainRef.current?.onAttachFiles?.(Array.from(e.target.files)); e.target.value = ''; }} />
            ) : (
              <input ref={fileInputRef} type="file" multiple
                aria-hidden="true" tabIndex={-1}
                accept="image/*,audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,text/*,.json,.md,.markdown,.csv,.xml,.yaml,.yml,.log,.out,.diff,.patch,.ts,.tsx,.js,.jsx,.py,.java,.go,.rs,.c,.h,.cpp,.hpp,.cs,.rb,.php,.swift,.kt,.sh,.sql,.html,.css,.scss,.toml,.ini,.cfg,.vue,.svelte,.pdf,.docx,.xlsx,.xls,application/pdf"
                className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
                onChange={e => { if (e.target.files?.length) handleIncomingFiles(Array.from(e.target.files)); e.target.value = ''; }} />
            )}
            // The ONE status line under the pill (owner 2026-09-17). The input
            // is never disabled by status: a send to a running session
            // steers/queues, a send to an errored session retries setup
            // (ensureRunnable re-provisions on run start) — the sentences live
            // in depth-ux-seams.ts RUN_NOTE (composerRunAffordance): "Stop ends
            // it." only while a stream is attached here.
            // Digby Frontier: the status line (when there is one) takes the
            // disclaimer's slot — 11.5px ink-3, centred, 10px under the box.
            footerNote={
              memberViewOnly
                ? <p data-composer-note className="text-[11.5px] leading-snug text-ink-3 mt-2.5 px-1 text-center">Read-only — this coding session belongs to the project owner. You can read the transcript and watch runs; ask the owner to run your request, or start a new chat in the folder.</p>
                : composerRun.note ? <p data-composer-note className="text-[11.5px] leading-snug text-ink-3 mt-2.5 px-1 text-center">{composerRun.note}</p>
                : plain ? <p data-composer-disclaimer className="text-[11.5px] text-ink-3 mt-2.5 text-center">Digby can make mistakes. Check important info.</p>
                : undefined
            }
          />
          </div>{/* /measure */}
        </div>
      </div>

      {/* Right Workspace panel — in-flow column at md+, slide-over drawer
          below (Phase 1 item 7: aligned to the app's ONE md breakpoint — it
          used to go modal below xl while every rail switched at md).
          C3 blocker 2 (ticket 71b1fec6, design D1): BOTH session kinds mount it
          here now — the ONE panel implementation. Coding sections build from
          the registry below (view-owned data); plain sections arrive via
          plain.panelSections (page-owned nodes, built by the page through the
          SAME registry with kind:'plain'). The open state is the page-owned
          controlled `panelOpen` for BOTH kinds (⋯-menu "Side panel" toggle,
          the visible PanelRight pill, WorkspacePanel X, and the mobile
          backdrop all drive it). */}
      {panelRendered && (() => {
        const closePanel = () => setPanel(false);
        // Browser section (Phase 6a): built HERE for both session kinds — the
        // view owns the activity stream. Conditional presence: it exists only
        // once the conversation has browser activity (the registry cap). The
        // registry orders it LAST; the plain-mode append below matches that
        // order exactly (the page builds its sections before any activity can
        // exist, so the node cannot come from page.tsx).
        // Permanent since 2026-09-23 (owner: "I don't see where the browser
        // tab is"): the tab always exists — BrowserActivityView renders its
        // own empty state until frames (live) or persisted screenshots (seed)
        // arrive.
        const browserSection: WorkspaceSection | null = {
          id: 'browser',
          label: WORKSPACE_SECTION_LABELS.browser,
          icon: <Globe className="size-3.5" />,
          node: <BrowserActivityView activity={browserActivity} live={live.running} />,
        };
        return <>
        {panelOpen && (
          <div
            className="fixed inset-0 bg-black/40 z-(--z-overlay-backdrop) md:hidden"
            style={{ height: 'var(--app-height, 100dvh)', top: 'var(--app-top, 0px)' }}
            onClick={closePanel}
          />
        )}
        <aside
          // Safe-area top (ticket c0e58120, iPhone Dynamic Island): the shell
          // is viewport-fit=cover, so this panel's tab strip rendered UNDER the
          // status bar / island in the installed app and its tabs could not be
          // tapped. env() is 0 everywhere without an inset (desktop, macOS app),
          // so the padding is inert there and correct on iPad standalone too.
          // LANDSCAPE complement (same ticket): the island moves to the right
          // edge (~59px) — paddingRight keeps the panel's controls clear of it;
          // env() is 0 on notch-free devices/orientations, so a no-op there.
          style={{
            ['--panel-w' as any]: `${panelRail.width}px`,
            // Digby Frontier: the panel never squeezes the chat below 380px —
            // the effective width clamps to what the viewport (minus the open
            // sidebar) leaves over.
            ['--panel-eff-w' as any]: 'min(var(--panel-w), max(280px, calc(100vw - var(--sidebar-open-w, 0px) - 380px)))',
            paddingTop: 'env(safe-area-inset-top, 0px)',
            paddingRight: 'env(safe-area-inset-right, 0px)',
          }}
          aria-hidden={!panelOpen || undefined}
          inert={!panelOpen || undefined}
          className={cn(
            // Digby Frontier skin (2026-10-06): flush right, ONLY the inner
            // corners rounded, NO border, the same --bg as the chat, and a
            // soft left-pointing shadow while open.
            'flex-col shrink-0 bg-background relative overflow-hidden rounded-l-[18px]',
            panelOpen
              // Drawer mode pins to the visual viewport (--app-height/--app-top
              // from the layout-mounted hook) like every other drawer.
              ? 'flex fixed inset-y-0 right-0 z-(--z-overlay) w-[85vw] max-w-sm shadow-(--panel-shadow) max-md:h-[var(--app-height,100dvh)] max-md:top-[var(--app-top,0px)]'
              : 'hidden',
            // Desktop: an in-flow column whose WIDTH animates open/closed
            // (380ms ease-out, shadow with it); it stays mounted while closed
            // (inert) so the close can animate. md:relative, never `static`
            // (owner report 2026-09-09 "side panel still isn't resizable"): the
            // ResizeHandle below is absolutely positioned against THIS aside.
            'md:flex md:relative md:inset-auto md:z-(--z-raised) md:max-w-none',
            'md:transition-[width,box-shadow] md:duration-[380ms] md:ease-(--ease-out)',
            panelOpen ? 'md:w-[var(--panel-eff-w)] md:shadow-(--panel-shadow)' : 'md:w-0 md:shadow-none',
            panelRail.resizing && 'md:transition-none',
          )}>
          {/* Resize handle — md+ only (below md the panel is a fixed-width
              slide-over drawer, so the handle hides with the media query). */}
          <ResizeHandle
            onPointerDown={panelRail.startResize}
            onReset={panelRail.reset}
            onNudge={panelRail.nudge}
            label="Resize workspace panel"
            className="hidden md:flex absolute left-0 top-0 h-full w-2.5 -ml-1.5 z-(--z-raised)"
          />
          {/* Sections come from the capability-keyed registry (C2, ticket
              71b1fec6, design D1) — the same table the page-level panel uses —
              so the two mounts can't drift on WHICH sections exist. The X lives
              in WorkspacePanel itself, for every section of every kind. */}
          {/* Inner content keeps a fixed width so it never reflows mid-animation. */}
          <div className="flex h-full min-h-0 w-full flex-col md:w-[var(--panel-eff-w)] md:flex-shrink-0">
          <WorkspacePanel onClose={closePanel} sections={withLeadSection(supervisorSection, plain
            ? [...(plain.panelSections ?? []), ...(browserSection ? [browserSection] : []), ...(settingsSection ? [settingsSection] : [])]
            : workspaceSectionIds({ kind: 'coding', isKid, hasBrowserActivity: !!browserSection }).map((sid): WorkspaceSection | null => {
            if (!chatId) return null; // coding sessions always have an id — narrows for ChatFilesSection below
            switch (sid) {
              // Browser (Phase 6a): the live agent-browse view — registry-gated
              // on hasBrowserActivity, so this case only fires when the node exists.
              case 'browser': return browserSection;
              // Settings (2026-09-09): page-built node, view-mounted LAST.
              case 'settings': return settingsSection ?? null;
              case 'overview': return { id: sid, label: WORKSPACE_SECTION_LABELS[sid], node: (
            <OverviewPanel
              project={project}
              session={activeSession as CodingSession}
              plan={plan}
              running={live.running}
              context={live.context}
              sessionUsage={sessionUsage}
              lastAdded={lastAddedTokens}
              processes={live.processes}
              loop={live.running ? live.loop : undefined}
              previewHint={previewHint}
              previewDefaultPort={previewDefaultPort}
              showSchedulesLink={!isKid}
              onAddTodo={addTodo}
              onCycleTodo={cycleTodo}
              onDeleteTodo={deleteTodo}
              onSaveGoal={saveGoal}
            />
          ) };
            // Files (59a4454e): the session chat's canvases as a file browser —
            // same panel component the chat surface uses, fed per-chat.
            // 999e3dbe (Phase 1): CodingFilesTabs splits the section into two
            // labeled sub-tabs — "Files" (the unchanged uploads+canvases pane)
            // and "Worktree" (the session's on-disk worktree as a lazy
            // read-only tree; a file click opens it in the canvas panel via
            // openWorktreeFile). Plain chats keep the page-built single-pane
            // Files section (no tab strip).
              case 'files': return { id: sid, label: WORKSPACE_SECTION_LABELS[sid], icon: <FileText className="size-3.5" />, node: (
              <CodingFilesTabs
                chatId={chatId}
                onOpenWorktreeFile={openWorktreeFile}
                activeWorktreePath={activeFileId && activeFileId.startsWith(WORKTREE_CANVAS_PREFIX) ? activeFileId.slice(WORKTREE_CANVAS_PREFIX.length) : null}
                filesNode={(
              <FilesPane
                docOpen={!!activeFileId}
                filesNode={(
                  <ChatFilesSection
                    chatId={chatId}
                    refreshKey={filesRefreshKey}
                    docs={chatFiles}
                    onOpenDoc={setActiveFileId}
                    onNewFile={createChatFile}
                  />
                )}
                docNode={(
                  <CanvasPanel
                    canvases={chatFiles}
                    activeCanvasId={activeFileId}
                    onUpdateCanvas={updateChatFile}
                    onDeleteCanvas={deleteChatFile}
                    onSelectCanvas={setActiveFileId}
                    onCreateCanvas={createChatFile}
                    onDownloadReadOnly={downloadWorktreeCanvas}
                  />
                )}
              />
                )}
              />
            ) };
              // Schedules tab (rm9): the chat's scheduled runs with cancel/pause
              // — no confirmation dialogs (short Undo instead). The registry
              // already withheld it for kid accounts.
              case 'schedules': return { id: sid, label: WORKSPACE_SECTION_LABELS[sid], icon: <CalendarClock className="size-3.5" />, node: <SchedulesSection chatId={chatId} /> };
              // NO fleet case (owner scoping principle 2026-09-07): the panel
              // pertains to THIS session — the account-wide fleet dashboard
              // lives on /management, and the Project Pulse block the Fleet tab
              // carried now renders at the top of Overview (scoped to the
              // session's own project). The ONE exception (owner 2026-10-08):
              // a supervisor chat's own scope IS its project / the fleet, so
              // withLeadSection puts the Project / Fleet dashboard first.
              // 'artifacts' is a plain-session section (D1: coding folds
              // artifacts into Files today) — the registry never emits it here.
              default: return null;
            }
          }).filter((s): s is WorkspaceSection => s !== null))} />
          </div>
        </aside>
        </>;
      })()}
      {/* Browser program (Phase 6a) — mobile bottom sheet (the ChatGPT pattern):
          on small screens agent browsing surfaces HERE instead of the side
          panel. Auto-opens on live observations (dismissal sticks — see
          lib/browser-activity.ts); the transcript pill above reopens it. */}
      <BrowserBottomSheet
        activity={browserActivity}
        live={live.running}
        open={browserSheet.open}
        onClose={() => setBrowserSheet(s => nextBrowserSheetState(s, 'dismiss'))}
      />
    </div>
    </ChatOpenContext.Provider>
    </TaskCardActionsContext.Provider>
    </WorktreeOpenContext.Provider>
  );
}
