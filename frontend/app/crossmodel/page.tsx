'use client';

import { Fragment, useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { splitSessionTitle } from '@/lib/session-title';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { LoadErrorState } from '@/components/ui/load-error-state';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Label } from '@/components/ui/label';
import { surfaceConfirmSecret } from '@/lib/confirm-secret';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import {
  Send,
  Loader2,
  Check,
  LogOut,
  Database,
  MessageSquare,
  Plus,
  Trash2,
  Pencil,
  X,
  Copy,
  Settings,
  GitBranch,
  Paperclip,
  Folder,
  FolderOpen,
  FolderPlus,
  SquarePen,
  Share2,
  Users,
  ChevronRight,
  ChevronDown,
  Link2,
  Files,
  MoreVertical,
  Mic,
  MicOff,
  Search,
  Shield,
  ScrollText,
  Newspaper,
  ArrowRight,
  ChevronUp,
  Clock,
  RefreshCw,
  CalendarDays,
  CalendarClock,
  MapPinIcon,
  Gauge,
  LifeBuoy,
  Lightbulb,
  Archive,
  ShieldCheck,
  ArrowUp,
  Share,
} from 'lucide-react';
import { authApi } from '@/lib/auth';
import { chatHasUnreadReply } from '@/lib/chat-attention';
import { isDefinitiveAuthFailure } from '@/lib/api-client';
import { childrenApi } from '@/lib/api/children';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useBranding } from '@/app/branding/BrandingProvider';
import { BrandSpinner } from '@/components/ui/custom/BrandSpinner';
import AppRail, { useRailOpen, RAIL_BREAKPOINT_PX } from '@/components/ui/custom/app-rail';
import { useResizable } from '@/lib/use-resizable';
import { usePolling, isAbortError } from '@/lib/use-polling';
// Sidebar live refresh (ticket d6b2eef5): delta merge + watermark helpers.
import { CHAT_LIST_LIVE_ACTIVE_MS, CHAT_LIST_LIVE_IDLE_MS, CHAT_LIST_LIVE_LIMIT, mergeChatRows, newestUpdatedAt, unknownRunningIds } from '@/lib/chat-list-live';
import { createRetainedCache, CHAT_LIST_CACHE_MAX, CHAT_LIST_CACHE_TTL_MS } from '@/lib/chat-view-cache';
import { useChatListEvents } from '@/lib/chat-events';
import { chatFlavorFromRow, chatFlavorFetchFallback } from '@/lib/chat-flavor';
import { trackVisitEvent } from '@/lib/visitor-analytics';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { crossModelApi, memoryApi, projectsApi, sharingApi, canvasApi, deepResearchApi, newsApi, calendarApi, imessageApi, suggestionsApi, weatherApi, confirmationsApi, CrossModelChat, Project, SharedProject, DeepResearchQuota, NewsHeadline, CalendarEvent, CalendarAppleHalf, HomeWeather, PendingConfirmation, instanceSetupApi, InstanceSetup } from '@/lib/api/crossmodel';
// Self-host setup hardening (2026-10-20): what THIS instance has configured (web search → news card, transparency pill).
import { webSearchUnavailable } from '@/lib/instance-setup';
import { summarizeFolderSessions, FOLDER_SESSION_SUMMARY_TTL_MS, type FolderSessionSummary } from '@/lib/folder-session-summary';
import { fleetApi } from '@/lib/api/fleet';
import { INITIAL_NEWS_POLL_STATE, NEWS_POLL_HEALTHY_MS, nextNewsPoll, NewsPollOutcome, NewsPollState } from '@/lib/news-polling';
// Ticket 94b93132: dated, honestly-labeled context for "ask about this story" injections.
import { buildNewsAskContext } from '@/lib/news-ask-context';
import { groupChatsByParent, flattenChatGroups, previewChatGroups } from '@/lib/chat-lineage';
import { groupRowsByRecency } from '@/lib/chat-recency';
import { RailBrandRow, RailActionRow, RailSectionLabel, RailLabelButton, RailFooter, WarnDot, railRowClass } from './components/rail-parts';
import type { CanvasItem } from './components/CanvasPanel';
import type { WorkspaceSection } from './components/WorkspacePanel';
import { workspaceSectionIds, WORKSPACE_SECTION_LABELS } from '@/lib/workspace-sections';
import RotatingTagline from './components/RotatingTagline';
import SchedulesSection from './components/SchedulesSection';
import { selectLiveChatConfirmations, selectLiveChatOwnerQuestions } from '@/lib/pending-chat-confirmations';
import FloatingChrome, { type CodingChrome } from './components/FloatingChrome';
import { codingApi } from '@/lib/api/coding';
import { useVoiceComposer } from './components/use-voice-composer';
import { buildPlainDepthConfig, fetchPlainRunActive } from './plain-session';
import GuestSidebar from './components/GuestSidebar';
import {
  loadGuestSessions,
  getGuestSession,
  upsertGuestSession,
  removeGuestSession,
  guestSessionTitle,
  retitleGuestSession,
  type GuestSessionRecord,
} from './guest-sessions';
import { getGuestGhost, setGuestGhost, clearGuestGhost } from '@/lib/ghost-mode';
import { ghostToggleTarget, ghostEligibleChatId, createChatWithGhost, flipChatGhost, withGhostFacts, holdPendingGhostFlips, ghostComposerToggleDisabled, type GhostToggleInput, type PendingGhostFlip } from '@/lib/ghost-composer';
import GhostComposerToggle from './components/GhostComposerToggle';
import type { ChatImage, CodingMessage } from '@/lib/api/coding';
import type { ChatComposerHandle } from './components/ChatComposerTextarea';
import { readPrefill, withoutPrefill } from '@/lib/chat-prefill';
import ChatComposer, { COMPOSER_ATTACH_BTN, COMPOSER_TOOL_BTN } from './components/ChatComposer';
import { weatherIconFor } from '@/lib/weather-icon';
import { AttachmentChips, AttachmentNotice, uploadChatFiles, type AttachmentInfo, type AttachmentRejection } from './components/attachments';
import { usePreferences, TEXT_SIZE_MAP, loadPrefs, normalizePatienceMode, type PatienceMode } from '@/lib/preferences';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  FolderRowDnd,
  ChatRowDnd,
  RootDropZone,
  SIDEBAR_ROOT_DROP_ID,
  sidebarCollisionDetection,
  type SidebarDragItem,
} from './components/sidebar-dnd';

/** Server-enforced folder nesting cap (backend MAX_FOLDER_DEPTH). */
const MAX_FOLDER_DEPTH = 5;

/** localStorage key for the sidebar folder tree's expanded/collapsed state. */
const EXPANDED_FOLDERS_KEY = 'crossmodel.expandedFolders';
/** How many of a folder's most-recent chats the sidebar shows before a "Show more" toggle. */
const FOLDER_CHAT_PREVIEW_COUNT = 5;
/** One nesting level of the folder tree: a 10px step + a 1px guide line + 6px
 *  gap (17px per level, linear). Rows inside carry no margin of their own —
 *  the container IS the indent (owner 2026-10-20 readability fix). */
const NEST_LEVEL_CLASS = 'ml-2.5 border-l border-line pl-1.5';

/** Attention dots: per-device last-viewed markers (localStorage). */
const CHAT_VIEWED_KEY = (id: string) => `crossmodel.chatViewedAt.${id}`;

function chatViewedAtMs(id: string): number {
  try {
    const raw = typeof window !== 'undefined' ? localStorage.getItem(CHAT_VIEWED_KEY(id)) : null;
    const t = raw ? Date.parse(raw) : 0;
    return Number.isFinite(t) ? t : 0;
  } catch { return 0; }
}

function writeChatViewed(id: string) {
  try { localStorage.setItem(CHAT_VIEWED_KEY(id), new Date().toISOString()); } catch { /* private mode */ }
}

/**
 * Unread = the latest message is the ASSISTANT's reply to a HUMAN turn and
 * newer than this device's last view of the chat. Keyed to lastMessageAt —
 * never updatedAt, which also bumps on renames/folder moves and must not flag
 * unread. Chats never opened on this device start clean (no dot storm on
 * first load). Owner 2026-09-16: machine-to-machine traffic (hook / schedule /
 * agent wakes, watchdog notes, status cards) never lights the dot — see
 * lib/chat-attention.ts.
 */
function chatHasUnread(chat: CrossModelChat): boolean {
  return chatHasUnreadReply(chat, chatViewedAtMs(chat.id));
}

/**
 * Composer message cap (ticket 4b7a32b1) — mirrors the supervisor composer's
 * gate (ticket eb7a3919 / SupervisorChatTab MAX_SUPERVISOR_MESSAGE_CHARS).
 * Oversized sends used to fail opaquely (a truncating fallback silently clipped
 * the message to 1,500 chars, or the register/URL path rejected it); now the
 * composer refuses up front with the length named, and a live character counter
 * appears once the draft nears the cap.
 * 2026-09-12 (ticket df145eb3): 8,000 → 100,000 — HUMAN-typed messages may
 * carry very large pasted context; the backend stream/register + sendChatMessage
 * paths impose no human-path length cap (platformSendMessageSchema has allowed
 * 100,000 all along) and express.json's 75mb body limit is nowhere near. The
 * machine-origin limits (schedule_self prompt 8,000, webhook 20,000) are
 * separate and unchanged.
 */
const MAX_CHAT_MESSAGE_CHARS = 100_000;
/** Show the live character counter from this length on. */
const NEAR_LIMIT_CHAT_CHARS = MAX_CHAT_MESSAGE_CHARS - 10_000;


/**
 * Sidebar attention indicator (in place of the spinner):
 * warn pulse = run blocked on YOUR input (approval/ask_user question),
 * ink-3 spinner = running, ok dot = unread reply waiting (Digby Frontier
 * neutral tokens, 2026-10-06 — no violet in chat chrome).
 */
function ChatAttentionIndicator({ chat, generating, isOpen }: { chat: CrossModelChat; generating: boolean; isOpen: boolean }) {
  if (chat.awaitingInput) {
    return (
      <span
        title={chat.awaitingKind === 'question' ? 'Waiting for your answer' : 'Waiting for your approval'}
        className="size-2 rounded-full bg-warn animate-pulse flex-shrink-0"
      />
    );
  }
  if (generating || chat.running) {
    return <Loader2 className="size-3 animate-spin text-ink-3 flex-shrink-0" />;
  }
  if (!isOpen && chatHasUnread(chat)) {
    return <span title="New response" className="size-2 rounded-full bg-ok flex-shrink-0" />;
  }
  return null;
}

/** Tree node: a folder with its child folders attached (chats render separately). */
type FolderNode = Project & { children: FolderNode[]; treeDepth: number };

/** Aggregated status of a folder subtree (direct chats + all descendant folders'). */
type FolderStatus = 'awaiting' | 'running' | 'unread';

/**
 * Roll a folder subtree's chat statuses up into ONE indicator with the same
 * priority as ChatAttentionIndicator (awaiting > running > unread). Restores
 * the folder-row indicators lost when subfolders landed: a TOP-LEVEL folder
 * must surface activity happening anywhere inside it, including in nested
 * subfolders — otherwise a running/waiting/finished session is invisible
 * while the folder is collapsed.
 */
function folderAggregateStatus(
  node: FolderNode,
  chats: CrossModelChat[],
  generatingIds: Set<string>,
  openChatId: string | null,
): FolderStatus | null {
  let awaiting = false;
  let running = false;
  let unread = false;
  const walk = (n: FolderNode) => {
    for (const c of chats) {
      if (c.projectId !== n.id) continue;
      if (c.awaitingInput) awaiting = true;
      else if (generatingIds.has(c.id) || c.running) running = true;
      else if (c.id !== openChatId && chatHasUnread(c)) unread = true;
    }
    n.children.forEach(walk);
  };
  walk(node);
  return awaiting ? 'awaiting' : running ? 'running' : unread ? 'unread' : null;
}

/** Folder-row counterpart of ChatAttentionIndicator (shown when the folder is collapsed). */
function FolderAttentionIndicator({ status }: { status: FolderStatus | null }) {
  if (status === 'awaiting') {
    return <span title="A chat in this folder is waiting for your input" className="size-2 rounded-full bg-warn animate-pulse flex-shrink-0" />;
  }
  if (status === 'running') {
    return <Loader2 className="size-3 animate-spin text-ink-3 flex-shrink-0" />;
  }
  if (status === 'unread') {
    return <span title="New response in this folder" className="size-2 rounded-full bg-ok flex-shrink-0" />;
  }
  return null;
}


// ─── Depth (roster 2026-10-06 B-3; the Advanced tab removed outright 2026-10-27 — ticket c99b404a) ──
// Digby picks depth and models per message: no depth control anywhere in the
// web app. Every signed-in
// web send is `mode='auto'` (plain-session.ts buildPlainDepthConfig →
// lib/depth-ux.ts depthPrefToWire; guests keep the forced Ensemble, kids their
// stored mode) and the ONE depth control is the "Dig deeper" chip under each
// answer. The former picker paths — the composer patience picker, the ⋯-menu /
// settings Patience groups, the label-window mode origin and the chat-open mode
// restore, all behind the never-forwarded NEXT_PUBLIC_DEPTH_UX_DISABLED build
// switch — are deleted. The API keeps accepting every mode alias (stored rows,
// mobile, REST, schedules).
// Digby Frontier (2026-10-06): the composer carries NO depth picker (owner,
// same day: "remove the picker — we don't want that available anymore");
// depth stays the compute policy + the "Dig deeper" chip under each answer.
/** Below this viewport width an opening side panel auto-collapses the sidebar. */
// Heavy views load on demand (2026-10-16 site review): the chat home is the
// front door from search, and the empty home renders none of these. The
// transcript view (markdown + syntax highlighting) is preloaded on the first
// keystroke / starter tap so the first send never waits on it.
const loadCodeSessionView = () => import('./components/CodeSessionView');
// Owner 2026-10-27 (stale-delete UI report): purging the module-level
// transcript snapshot of a deleted chat — dynamic-imported alongside the view
// that owns it (no static import of the whole heavy component here).
const purgeSessionSnapshot = (chatId: string) => { void loadCodeSessionView().then((m) => m.purgeSessionSnapshot(chatId)); };
const CodeSessionView = dynamic(loadCodeSessionView);
const CanvasPanel = dynamic(() => import('./components/CanvasPanel'));
const OwnerQuestionCard = dynamic(() => import('./components/OwnerQuestionCard'));
const ChatFilesSection = dynamic(() => import('./components/ChatFilesSection'));
const FilesPane = dynamic(() => import('./components/FilesPane'));
const ConnectedInstancesSection = dynamic(() => import('./components/ConnectedInstancesSection').then((m) => m.ConnectedInstancesSection));
const ArchivedSection = dynamic(() => import('./components/ArchivedSection').then((m) => m.ArchivedSection));
const SessionSettingsSection = dynamic(() => import('./components/SessionSettingsSection'));
const ImportProjectDialog = dynamic(() => import('./components/ImportProjectDialog'));
const AutonomyDialog = dynamic(() => import('./components/AutonomyDialog'));
const DeepSearchDialog = dynamic(() => import('./components/DeepSearchDialog'));

const PANEL_AUTOCOLLAPSE_BELOW_PX = 1280;

/**
 * Sidebar chat-list retention (ticket b5734922 — owner 2026-11-04: "every
 * navigation away from chats and back causes a long wait... why are chats not
 * cached?"). /account, /files and /management are sibling routes, so a round
 * trip UNMOUNTS this page and every reload is a cold load: the rail paints
 * "Loading chats…" skeletons until `listChats` settles.
 *
 * Module scope survives that unmount (it is the only thing that does), so the
 * last list seeds the rail's first paint and `fetchChatList` re-fetches on top
 * as it always did. `railSeeded` is the ONE new gate: while it is true the
 * retained rows render and the hydration gate is not consulted, which is what
 * turns the return visit from "skeleton → list" into "list → list (fresh)".
 *
 * CORRECTNESS: the seed is replaced wholesale by the fresh list on every
 * load (`setChats(chatsArr)` in fetchChatList), so a chat deleted on another
 * device, a rename, or a framework-spawned session all reconcile on the same
 * round trip. The retained rows can delay the truth by that round trip and can
 * never overwrite it. Memory-only (see lib/chat-view-cache.ts) so a deploy
 * never serves pre-deploy rows into a post-deploy bundle.
 */
const chatListCache = createRetainedCache<CrossModelChat[]>({
  ttlMs: CHAT_LIST_CACHE_TTL_MS,
  max: CHAT_LIST_CACHE_MAX,
});

/**
 * Keep the retained sidebar page in step with a LOCAL row change — called from
 * every path that patches `chats` in place (delete, archive, restore-Undo,
 * rename, move-to-project) and from every path that APPENDS a row (create,
 * spawn, load-more).
 *
 * WHY a patch and not a drop (review finding 1, 2026-11-04): `archiveChat` does
 * not remove a row, it sets `archivedAt`; a rename sets `title`; a move sets
 * `projectId`. Dropping those rows would be wrong (the chat still exists) and
 * doing nothing would let the PRE-change shape first-paint on the next return
 * visit — the owner's 2026-10-27 "a deleted chat still sits there" class
 * reached through the cache. `patch === null` means "this row is gone".
 *
 * A no-op when the id is not on the retained page: the retained page is only
 * ever a first paint, and a row it never held cannot go stale in it.
 */
function patchRetainedChat(chatId: string, patch: Partial<CrossModelChat> | null): void {
  const retained = chatListCache.read('first-page');
  if (!retained) return;
  if (patch === null) {
    const next = retained.value.filter((c) => c.id !== chatId);
    if (next.length === retained.value.length) return; // not in the retained page
    // Re-stamp at the ORIGINAL time: a delete must not extend the life of the
    // rows it leaves behind (review finding, 2026-11-04).
    if (next.length) chatListCache.write('first-page', next, retained.at);
    else chatListCache.purge('first-page');
    return;
  }
  const next = retained.value.map((c) => (c.id === chatId ? { ...c, ...patch } : c));
  chatListCache.write('first-page', next, retained.at);
}

/** Retain the CURRENT list after a local append (create / spawn / load-more).
 *  Without this the next return visit first-paints a list missing the chat the
 *  user just created — with `railReady` true there is no skeleton, and
 *  `hasMoreChats` starts false so "Load more" is not even offered until the
 *  refetch lands (review finding 1, 2026-11-04). */
function retainApiChatRow(chat: CrossModelChat | null | undefined): void {
  if (!chat?.id) return;
  const retained = chatListCache.read('first-page');
  if (!retained) return;
  if (retained.value.some((c) => c.id === chat.id)) return; // already known
  chatListCache.write('first-page', [chat, ...retained.value].slice(0, 30));
}

/**
 * The fleet-hidden chat ids, mirrored at module scope.
 *
 * WHY (review finding, 2026-11-04): `fleetHidden` is React state that starts as
 * an empty Set and only fills after `fleetApi.getSupervisor()` resolves
 * (page.tsx, the fleet-hidden effect). `visibleChats` filters with it — so a
 * retained first paint would show an admin the fleet chats in the CHATS rail
 * until that probe lands, and indefinitely if the probe fails. The coding
 * snapshot never had this problem because it is transcript-shaped; the rail is
 * not. Mirroring the set at module scope lets the SEED filter with the last
 * known answer instead of an empty one.
 */
let retainedFleetHiddenChatIds: ReadonlySet<string> = new Set();

function rememberFleetHidden(chatIds: ReadonlySet<string>): void {
  retainedFleetHiddenChatIds = chatIds;
}

/** Starter prompts under the guest home composer (2026-10-16 site review) — a
 *  tap prefills the composer; signed-in users get personalised ones instead. */
const GUEST_STARTERS = [
  'Plan a 3-day trip to Québec City',
  'What are my rights as a tenant in Ontario?',
  'Summarise this week’s AI news in Canada',
  'Write a polite email asking for an extension',
] as const;

// ─── Types ────────────────────────────────────────────────────────────────────

// (C3 deletion pass, §5b: the local formatMessageTime moved to
// @/lib/format-message-time — the legacy transcript now imports the shared
// copy. MODEL_ROLES / inferModelSet / ModelCard died with the admin-only
// More-info model-response panel: it required a signed-in admin, and
// signed-in chats no longer render on this page's legacy transcript.)

// ─── Main Page ────────────────────────────────────────────────────────────────

/**
 * One honest sentence for the macOS Calendar half of the Today card
 * (2026-11-06). The owner's report — "calendar sync isn't working or showing in
 * my digby calendar on new chats or context" — was made worse by a card that
 * showed a Mac read failure as an ordinary free day. So this function exists to
 * be blunt: it names the Mac, says what state it is in, and never turns a
 * never-granted Mac into "Nothing on your calendar today".
 *
 * The consent clause repeats ONLY what the agent observed; it can never claim a
 * dialog appeared, because the agent's request is asynchronous and its outcome
 * is not observable from here.
 */
function appleCalendarNotice(apple: CalendarAppleHalf): string {
  const device = apple.device || 'your Mac';
  const at = apple.consent ? new Date(apple.consent.at) : null;
  const when = at && !Number.isNaN(at.getTime())
    ? at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  switch (apple.state) {
    case 'calendar-never-requested':
      return apple.consent?.state === 'dialog-open'
        ? `Waiting for Calendar permission on ${device} — a macOS prompt may be on that Mac's screen.`
        : apple.consent?.state === 'bridge-failed'
          ? `macOS wouldn't show the Calendar prompt on ${device}. Grant it by hand: System Settings → Privacy & Security → Calendars.`
          : `macOS Calendar access hasn't been granted on ${device} yet. Open System Settings → Privacy & Security → Calendars on that Mac and enable the Digby agent.`;
    case 'calendar-denied':
      return `Calendar access is off for the Digby agent on ${device} — enable it in System Settings → Privacy & Security → Calendars.`;
    case 'no-calendar-account':
      return `${device} isn't signed in to an Apple account, so it has no Apple calendar to show.`;
    case 'calendar-unreachable':
      return `Couldn't reach the calendar on ${device}.`;
    case 'unsupported':
      return `${device} needs a newer Digby agent to read Calendar.`;
    case 'no-agent':
      return 'No paired Mac can read Apple Calendar right now.';
    default:
      return when ? `Mac calendar last checked ${when}.` : '';
  }
}

export default function CrossModelPage() {
  // Shared branding core (todo d2d32b57): one snapshot resolved on the server
  // by app/layout.tsx; defaults to Digby when an operator configured nothing.
  const branding = useBranding();
  const router = useRouter();
  const [user, setUser] = useState<any>(null);
  // Access token for the SSE invalidation stream (6201e0ee): EventSource
  // cannot set headers, so the chat-events subscription needs the raw token
  // for the ?token= query param. Read once on mount (the auth effect below
  // populates it); null = signed out → the subscription stays closed.
  const [accessToken, setAccessToken] = useState<string | null>(null);
  // Ad Manager library gate REMOVED (todo 9a3e82af): the Google Ad Manager
  // library and the streaming "thinking" ad slot it powered are gone —
  // Digby is ad-free in-product, so there is no ad library to gate and no
  // doubleclick request left to make on any session, child or adult.
  // Digby Kids: a child login is forced server-side onto the locked-down kid
  // pipeline (Qwen 3.6 + web search + strict prompt). In the UI we hide the
  // patience/model controls since they're inert for a child — keeps it simple.
  const isKid = !!user?.isChild;
  // Model-details ("More info") panels are an ADMIN debugging surface — hidden
  // from regular users (owner directive 2026-07-24). Same admin check as the
  // account page.
  const isAdmin = user?.role === 'ADMIN' || user?.email?.toLowerCase() === 'example-user@example.com';
  // Connected Google accounts — used by the email draft card's "From" picker so a
  // Draft text now lives inside <ChatComposerTextarea> (composerRef), NOT in this giant component —
  // so typing doesn't re-render the whole page. `hasText` mirrors only empty↔non-empty transitions
  // (for the Send button). `setInput` is a shim so every existing setInput(...) call site still works.
  const composerRef = useRef<ChatComposerHandle>(null);
  const [hasText, setHasText] = useState(false);
  // Near-limit character counter (ticket 4b7a32b1): 0 while well under the cap
  // (no re-render per keystroke — the draft deliberately lives inside the
  // composer's imperative handle), the live length once the draft enters the
  // warning zone. Mirrors SupervisorChatTab's charCount.
  const [charCount, setCharCount] = useState(0);
  const setInput = useCallback((v: string | ((prev: string) => string)) => {
    const cur = composerRef.current?.getValue() ?? '';
    const next = typeof v === 'function' ? (v as (prev: string) => string)(cur) : v;
    // Guard: never pass undefined/null to setValue — propagating undefined causes
    // the composer to display 'undefined' as text and save it to chat history.
    // The `?? ''` only catches a real null/undefined; it does NOT catch the STRING
    // 'undefined'/'null' (truthy) or '[object Object]' from a failed template literal
    // or String(obj) upstream (e.g. a follow-up button built from a missing field).
    // Normalize those sentinel strings to empty here so the composer never shows them.
    let safe = next ?? '';
    const trimmed = safe.trim();
    if (trimmed === 'undefined' || trimmed === 'null' || trimmed === '[object Object]') {
      safe = '';
    }
    composerRef.current?.setValue(safe);
  }, []);
  // The stored patience preference — since roster 2026-10-06 B-3 read for KIDS only (their sends carry it
  // untouched; signed-in adults always send Auto, guests the forced Ensemble — plain-session.ts
  // buildPlainDepthConfig). Legacy values ('code', 'deep_research_all', 'single', 'fast') stay in the
  // PatienceMode union so old stored prefs/chat rows typecheck; lib/preferences migrates them on read.
  const [mode, setMode] = useState<PatienceMode>(() => {
    if (typeof window === 'undefined') return 'auto';
    return loadPrefs().patienceMode;
  });
  const [webSearch] = useState(true);

  // ── Sidebar pending-action banner (confirmations poll) ─────────────────
  // (The inline ask_user card retired with the legacy transcript — C3; the
  // converged view renders its own. The banner below covers coding sessions.)
  const [pendingConfirmations, setPendingConfirmations] = useState<PendingConfirmation[]>([]);
  const refreshPendingConfirmations = useCallback(async (signal?: AbortSignal) => {
    try {
      const list = await confirmationsApi.getPending({ signal });
      const pending = Array.isArray(list) ? list : [];
      setPendingConfirmations(pending);
    } catch { /* best-effort poll — a transient/aborted tick keeps the last state */ }
  }, []);
  // First-class decisions queue (ticket 43212128): agent-flagged owner
  // questions NEVER expire, so they render as their OWN subsection at the very
  // top of the rail — every one listed with one-tap approve/decline — plus a
  // count badge on the Management link. The 2026-09-05 incident: decisions
  // surfaced only as text lines in supervisor wake notes and scrolled away
  // for days unseen. Everything else keeps the generic banner below.
  // Rows a supervisor is answering first (`triaged`) are listed for honesty but
  // are NOT "needs you" — they surface as decisions only if the SLA elapses.
  const pendingOwnerDecisions = pendingConfirmations.filter((p) => p.kind === 'owner_question' && !p.triaged);
  const pendingOtherItems = pendingConfirmations.filter((p) => p.kind !== 'owner_question' || p.triaged);
  const [resolvingDecisionId, setResolvingDecisionId] = useState<string | null>(null);
  /** One-tap approve/decline of a flagged decision — the answer is posted back
   *  into the flagging chat's transcript and the chat is woken immediately
   *  (same server path as the Management → Inbox free-text answer). */
  const handleAnswerOwnerQuestion = useCallback(async (p: PendingConfirmation, answer: string, opts?: { credentialPaste?: boolean }) => {
    setResolvingDecisionId(p.id);
    try {
      const res = await confirmationsApi.answerOwnerQuestion(p.id, answer, opts);
      if (res.success) {
        // Post-merge review F-A: a paste that resolved the question but stored
        // NOTHING (preset-managed key / size limit / kill switch) must not
        // toast "Key stored" — the vault kept the old value.
        toast.success(opts?.credentialPaste
          ? (res as { pasteRefused?: boolean }).pasteRefused
            ? 'Question resolved — but the pasted key was NOT stored (it may be preset-managed or refused). A previously stored key still governs; manage it under Account → Coding → Credentials.'
            : 'Key stored — the gate is open and the chat is being told now.'
          : answer === 'Approved.' ? 'Approved — the chat is told now.' : answer === 'Declined.' ? 'Declined — the chat is told now.' : 'Answer sent — the chat is told now.');
      } else if (res.error === 'reply_recorded') {
        // Todo 0dd7d3f2: a choice/yes_no gate got non-matching text — the
        // reply reached the asking chat as conversation; only the resolution
        // is refused. The old credential_pending conflation showed the
        // credential banner on non-credential cards.
        // 2026-10-20: a credential card answers the same code when the owner
        // typed WORDS (not the key) — the asking agent is woken to answer on
        // the card; the gate still needs the key through the key field.
        // 2026-10-21 (ticket c1714329): the wake fires on a choice/yes_no
        // card too — a fresh owner reply always wakes the asking lane, even
        // though the card stays open until the declared shape arrives.
        toast.info(p.needsCredential
          ? 'Sent to the agent as a reply — it is being woken to answer you on this card. The card stays open until the key is stored (paste it in the key field).'
          : 'Sent to the chat as a reply — the chat is being woken with your words now. The card stays open until you pick an option (or a yes/no ruling).');
      } else if (res.error === 'credential_pending') {
        // Since 2026-10-20 only a paste-shaped reply (a token / PEM typed as
        // text) lands here; plain words go through reply_recorded above.
        toast.error('Recorded — but that looked like a key, and keys pasted as text are never stored. Paste it in the key field on the card (it goes straight to your encrypted credentials), store it via store_secret, or add it under Account → Coding → Credentials. The question stays open.');
      } else {
        toast.error(res.error === 'not_open' ? 'Already resolved elsewhere.' : res.error || 'Failed.');
      }
    } catch {
      toast.error('Could not reach the server — try again.');
    } finally {
      setResolvingDecisionId(null);
    }
    void refreshPendingConfirmations();
  }, [refreshPendingConfirmations]);
  /** Owner 2026-09-22: the same one-tap flow for the flagger's typed OPTIONS
   *  and for the in-flow card in the open chat (OwnerQuestionCard). */
  const handleDismissOwnerQuestion = useCallback(async (p: PendingConfirmation) => {
    setResolvingDecisionId(p.id);
    try {
      const res = await confirmationsApi.dismissOwnerQuestion(p.id);
      if (res.success) toast.success('Dismissed.');
      else toast.error(res.error === 'not_open' ? 'Already resolved elsewhere.' : res.error || 'Failed.');
    } catch {
      toast.error('Could not reach the server — try again.');
    } finally {
      setResolvingDecisionId(null);
    }
    void refreshPendingConfirmations();
  }, [refreshPendingConfirmations]);
  // Poll every 20s while the tab is visible + immediately on foreground —
  // usePolling (P5): abortable ticks (a stale response can never overwrite a
  // newer list), pauses hidden with a catch-up tick on return to visible.
  useEffect(() => { if (!user) setPendingConfirmations([]); }, [user]);
  usePolling(
    (signal) => refreshPendingConfirmations(signal),
    { intervalMs: 20_000, enabled: !!user },
  );
  // Sidebar pending-action card: confirm/cancel a DB-persisted staged
  // consequential action inline — the server consumes the row one-shot and
  // executes the STORED args, so a double-click can never run it twice.
  const handleResolvePendingAction = useCallback(async (p: PendingConfirmation, action: 'confirm' | 'cancel') => {
    try {
      const res = action === 'confirm'
        ? await confirmationsApi.confirmAction(p.id)
        : await confirmationsApi.cancelAction(p.id);
      if (res.success) {
        // A minted secret (create_chat_webhook) rides the result ONCE — show it here or nowhere.
        if (!(action === 'confirm' && surfaceConfirmSecret((res as { result?: string }).result))) toast.success(action === 'confirm' ? 'Action confirmed — running now.' : 'Action cancelled.');
      } else {
        toast.error(
          res.error === 'expired'
            ? 'That action expired — ask the chat to try again.'
            : res.error === 'already_resolved'
              ? 'Already resolved.'
              : res.error || 'The action failed to run.',
        );
      }
    } catch {
      toast.error('Could not reach the server — try again.');
    }
    void refreshPendingConfirmations();
  }, [refreshPendingConfirmations]);

  // Sidebar approval card (owner 2026-10-20): answer a tool approval inline
  // through the run's own approval endpoint — the same call the chat view's
  // Allow / Always / Deny buttons make — so the rail never shows an ask the
  // user cannot act on. The registry resolves a decision one-shot; a second
  // click lands on a gone row and the refresh simply drops the card.
  const handleResolvePendingApproval = useCallback(async (p: PendingConfirmation, decision: 'allow' | 'always' | 'deny') => {
    setResolvingDecisionId(p.id);
    try {
      await codingApi.approve(p.id, decision);
      toast.success(decision === 'deny' ? 'Denied.' : decision === 'always' ? 'Allowed for the rest of the run.' : 'Allowed — running now.');
    } catch {
      toast.error('Could not send that decision — open the chat and answer there.');
    } finally {
      setResolvingDecisionId(null);
      void refreshPendingConfirmations();
    }
  }, [refreshPendingConfirmations]);
  // Sidebar question card: one-tap option answer through the ask_user answer
  // endpoint (992c8374: {success:false} = the wait is already gone — say so,
  // never clear the card silently).
  const handleAnswerPendingQuestion = useCallback(async (p: PendingConfirmation, answer: string) => {
    setResolvingDecisionId(p.id);
    try {
      const res = await codingApi.answerQuestion(p.id, answer);
      if (res.success) toast.success('Answer sent.');
      else toast.error(res.error || 'That question is no longer waiting — open the chat to continue.');
    } catch {
      toast.error('Could not send that answer — open the chat and answer there.');
    } finally {
      setResolvingDecisionId(null);
      void refreshPendingConfirmations();
    }
  }, [refreshPendingConfirmations]);

  const agentAttachEsRef = useRef<EventSource | null>(null);

  // --app-height/--app-top (visual-viewport pinning) is mounted by the
  // /crossmodel LAYOUT (<AppViewportVars />) since the Phase-1 shell pass —
  // instances/profile and the drawer surfaces read the vars too, so the
  // page-local copy that only this route mounted is gone.

  // ── Context & chat state ──────────────────────────────────────────────────
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<CrossModelChat[]>([]);
  // Fleet Management: fleet chats (supervisor + legacy duplicates) and fleet
  // project folders are hidden from the sidebar (they live under /management
  // instead). Empty sets until the supervisor endpoint answers (or on failure).
  const [fleetHidden, setFleetHidden] = useState<{ chatIds: Set<string>; projectIds: Set<string> }>({ chatIds: new Set(), projectIds: new Set() });
  const [newsHeadlines, setNewsHeadlines] = useState<NewsHeadline[]>([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [expandedNewsIndices, setExpandedNewsIndices] = useState<Set<number>>(new Set());
  const [copiedNewsIndex, setCopiedNewsIndex] = useState<number | null>(null);
  const [readNewsIndices, setReadNewsIndices] = useState<Set<number>>(new Set());
  const newsCardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [newsVisibleCount, setNewsVisibleCount] = useState(6); // Show 6 initially, load more on click

  // ── Home screen: personalized starter questions + location/weather ────────
  const DEFAULT_STARTER_QUESTIONS = [
    'What should I learn in tech in 2026?',
    'Explain quantum computing simply',
    'How do I negotiate a higher salary?',
    'What makes a great startup idea?',
    'Compare React, Vue, and Svelte',
    'How does the immune system work?',
  ];
  const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>(DEFAULT_STARTER_QUESTIONS);
  const [homeWeather, setHomeWeather] = useState<HomeWeather | null>(null);

  // ── Calendar events state ──────────────────────────────────────────────────
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarLoading, setCalendarLoading] = useState(false);
  // Connected but today's read failed (2026-10-21): the Today card shows the
  // failure + Retry instead of disappearing.
  const [calendarError, setCalendarError] = useState<null | 'unavailable' | 'reconnect'>(null);
  // The macOS/Apple half of the Today card (2026-11-06). null = no Mac half
  // reported (older backend, or no Mac paired). `state !== 'ok'` is a READ
  // FAILURE with a reason — never an empty day.
  const [calendarApple, setCalendarApple] = useState<CalendarAppleHalf | null>(null);
  // Tick counter — increments every 60s to re-evaluate which events are past/upcoming
  const [, setCalendarTick] = useState(0);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // iMessage confirm-before-send: populated by the 'imessage-draft' SSE event
  // (forwarded by CodeSessionView's plain bridge via onImessageDraft — E5
  // 2026-09-25 re-wire). `decisionId` is the send-intent gate's parked
  // decision: Send labels it confirmed (inside /imessage/send), Cancel/close
  // labels it declined (/imessage/draft-outcome) — telemetry only.
  const [imsgDraft, setImsgDraft] = useState<{ to: string; displayName: string; text: string; resolved: boolean; decisionId?: string } | null>(null);
  const [imsgSending, setImsgSending] = useState(false);
  const declineImsgDraft = useCallback((draft: { decisionId?: string } | null) => {
    setImsgDraft(null);
    if (draft?.decisionId) void imessageApi.draftOutcome(draft.decisionId, 'declined').catch(() => {});
  }, []);
  // Hydration-safe (Phase 1 item 5): the server and first client render both
  // say OPEN (deterministic desktop default); the real value — prefs +
  // viewport width — lands in useRailOpen's pre-paint mount effect. The old
  // initializer read window.innerWidth + localStorage during render: a
  // guaranteed server/client mismatch and a first-paint open-drawer flash on
  // phones.
  const [sidebarOpen, setSidebarOpen] = useRailOpen(() => {
    const p = loadPrefs();
    if (p.sidebarDefault === 'closed') return false;
    return window.innerWidth >= RAIL_BREAKPOINT_PX;
  });
  const [deletingChatId, setDeletingChatId] = useState<string | null>(null);
  // Archive: bumps after every archive action so an OPEN Archived section
  // refetches (it lazy-loads on expand otherwise).
  const [archiveVersion, setArchiveVersion] = useState(0);
  // "Needs your input" rail block (Phase 1 item 6): collapsed by default to a
  // one-line count row — the full question cards could eat a third of the rail.
  const [needsInputExpanded, setNeedsInputExpanded] = useState(false);
  // "Decisions needed" queue (ticket 1101e72c): the owner-question cards get
  // the same default-collapsed treatment — one long flagged question could
  // otherwise eat the whole rail. One compact count row; cards on demand.
  const [decisionsExpanded, setDecisionsExpanded] = useState(false);
  // Per-card long-question expansion (1101e72c): >120-char questions clamp to
  // two lines with a subtle Show more/less toggle instead of filling the card.
  const [chatsPage, setChatsPage] = useState(1);
  const [hasMoreChats, setHasMoreChats] = useState(false);
  const [loadingMoreChats, setLoadingMoreChats] = useState(false);
  // P4: honest sidebar — a failed chat-list fetch renders a retryable
  // LoadErrorState instead of the "No chats yet" empty state.
  const [chatListError, setChatListError] = useState(false);
  // Sidebar hydration (ticket 26edb492): the rail mounts the moment auth
  // resolves, but chats + projects are still `[]` until their first fetches
  // land — the sidebar used to render its EMPTY states during that window,
  // which reads as "my chats are gone". `sidebarHydrated` starts false and
  // flips true once the first chats+projects loads have SETTLED (success or
  // failure — the error/empty states own the failure render), so the rail can
  // show skeleton rows + "Loading chats…" instead of a blank rail.
  // One-shot: never re-arms on refetches (archive restores, Retry), so those
  // paths never flash a skeleton over already-rendered content.
  const [sidebarHydrated, setSidebarHydrated] = useState(false);
  // Retained first paint (ticket b5734922 — owner 2026-11-04: returning to
  // chats "causes a long wait"). `sidebarHydrated` is a ONE-SHOT gate that only
  // flips after the first list/folders/running fetches all settle, so without
  // this every return visit re-walks the skeleton path. When module scope still
  // holds this user's last list (a client-side navigation back from /account,
  // /files or /management — the only way the cache can be non-empty, since it
  // dies with the document) the rail renders those rows IMMEDIATELY instead of
  // skeletons. The list fetch still runs on every mount and REPLACES them
  // wholesale, so nothing stale survives one round trip.
  //   Seeded in its own mount effect, NOT during render: the server renders an
  //   empty rail, and seeding during render would hydration-mismatch. It also
  //   runs before `user` resolves, so the seed does not wait on the auth probe.
  const [railSeeded, setRailSeeded] = useState(false);
  // One derived gate for the CHATS list's loading arms: either the first fetches
  // have settled (the 26edb492 rule) or we have server-confirmed rows on screen.
  // The FOLDERS section deliberately keeps keying on `sidebarHydrated` alone —
  // folder rows are not retained, so they must keep their skeletons.
  const railReady = sidebarHydrated || railSeeded;
  // Resizable left sidebar (desktop) — the SHARED rail controller
  // (lib/use-resizable.ts, owner UI pass 2026-09-07): drag clamps 200–480,
  // double-click resets to 264 (Digby Frontier), width persists per surface ('digby.sidebar.w';
  // pre-pass widths migrate from the legacy key). Handle sits on the rail's
  // RIGHT edge — dragging right widens.
  const sidebarRail = useResizable({
    storageKey: 'digby.sidebar.w', defaultWidth: 264, minWidth: 200, maxWidth: 480,
    edge: 'right', legacyKeys: ['digbyChatRailW'],
  });
  // Hoist the open sidebar's width to the root as --sidebar-open-w (0px when
  // closed) — the FloatingChrome top fade scopes itself to the CHAT column
  // with it (owner 2026-09-08: the fade must not wash over the sidebar/panel).
  // Mirrors CodeSessionView's --panel-open-w hoist; only md:+ styles read it,
  // so the mobile overlay drawer (which sits above the fade's z) is unaffected.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--sidebar-open-w', sidebarOpen ? `${sidebarRail.width}px` : '0px');
    return () => { root.style.removeProperty('--sidebar-open-w'); };
  }, [sidebarOpen, sidebarRail.width]);

  // ── Memory state ──────────────────────────────────────────────────────────
  const [memoryFacts, setMemoryFacts] = useState<Record<string, string>>({});
  const [showMemoryPanel, setShowMemoryPanel] = useState(false);

  // ── Digby Kids logout gate (masked parent-PIN dialog — no window.prompt) ──
  const [kidLogoutOpen, setKidLogoutOpen] = useState(false);
  const [kidLogoutPin, setKidLogoutPin] = useState('');
  const [kidLogoutBusy, setKidLogoutBusy] = useState(false);

  const performLogout = () => {
    localStorage.removeItem('accessToken');
    // Retained chat data is module-scoped and therefore outlives this page
    // (ticket b5734922) — drop it so a second account in the same tab can never
    // first-paint rows retained for the first.
    chatListCache.clear();
    setUser(null);
    setChats([]);
    setCurrentChatId(null);
    setMemoryFacts({});
    toast.success('Logged out');
  };

  const handleKidLogout = async () => {
    if (!kidLogoutPin) return;
    setKidLogoutBusy(true);
    try {
      const ok = await childrenApi.verifyParentPin(kidLogoutPin);
      if (!ok) { toast.error('Incorrect PIN.'); return; }
      setKidLogoutOpen(false);
      performLogout();
    } catch {
      toast.error('Could not verify PIN.');
    } finally {
      setKidLogoutBusy(false);
    }
  };

  // ── Deep Research quota state ─────────────────────────────────────────────
  const [deepResearchQuota, setDeepResearchQuota] = useState<DeepResearchQuota | null>(null);

  // ── Copy state ────────────────────────────────────────────────────────────
  const { prefs, update } = usePreferences();

  // ── Upload / attachment state ─────────────────────────────────────────────
  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [uploading, setUploading] = useState(false);
  // Ticket 33a742c1: files that FAILED to stage, kept visible inline next to
  // the chips. Before this a rejected file produced only a transient toast and
  // no chip — so an attachment the composer had just shown as picked appeared
  // to vanish after the upload, with the message still sending.
  const [attachmentRejections, setAttachmentRejections] = useState<AttachmentRejection[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);


  // ── TTS (text-to-speech) state ─────────────────────────────────────────────

  // ── Inline chat rename state ───────────────────────────────────────────────
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // ── Projects state ────────────────────────────────────────────────────────
  const [ownedProjects, setOwnedProjects] = useState<Project[]>([]);
  const [sharedProjects, setSharedProjects] = useState<SharedProject[]>([]);
  // Expanded folders in the sidebar tree — persisted so the tree survives reloads.
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set();
    try {
      const raw = localStorage.getItem(EXPANDED_FOLDERS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [projectsSectionCollapsed, setProjectsSectionCollapsed] = useState(false);

  // Projects whose full chat list has already been merged into `chats` (see the
  // effect below). The sidebar only loads the 30 most-recent chats globally, so a
  // project with more/older chats showed its count but an empty dropdown — on expand
  // we fetch the project's complete chat list and merge it in. Fetch once per project.
  const projectChatsLoadedRef = useRef<Set<string>>(new Set());
  // In-flight guard + expected per-folder chat totals (from the last successful
  // detail fetch). If a global 30-cap list refresh REPLACES `chats` and drops a
  // loaded folder's chats, the effect below re-fetches and re-merges them
  // (loaded-ref alone made that loss permanent — the 2026-08 "16 count, 1 shown" bug).
  const projectChatsFetchingRef = useRef<Set<string>>(new Set());
  const projectChatTotalsRef = useRef<Map<string, number>>(new Map());
  const projectChatFailAtRef = useRef<Map<string, number>>(new Map());
  // Folders whose chat list is expanded past the FOLDER_CHAT_PREVIEW_COUNT preview.
  const [showAllFolderChats, setShowAllFolderChats] = useState<Set<string>>(new Set());
  // Sidebar-folder session summary row (session titles + topology, deferred
  // piece shipped 2026-09-28): ONE line at the top of an EXPANDED folder —
  // "2 running · 1 scheduled · last receipt 12 m · $4.10 today" — from the
  // same GET /projects/:id/sessions rows the Sessions tab renders. Fetched
  // lazily on expand, reused for FOLDER_SESSION_SUMMARY_TTL_MS, fail-open (a
  // 403 on a shared folder or any error ⇒ no row). A folder with no lanes
  // renders nothing.
  const [folderSessionSummaries, setFolderSessionSummaries] = useState<Map<string, { at: number; summary: FolderSessionSummary | null }>>(new Map());
  const folderSummaryFetchingRef = useRef<Set<string>>(new Set());
  // Owner 2026-10-27 (stale-list sweep): bump to invalidate every cached folder
  // summary (a delete/archive under a folder changed its lane roster; the TTL
  // would otherwise serve the stale line for up to 15 min).
  const [folderSummaryVersion, setFolderSummaryVersion] = useState(0);
  useEffect(() => {
    if (!user?.id) return;
    const now = Date.now();
    for (const folderId of expandedProjects) {
      const cached = folderSessionSummaries.get(folderId);
      if (cached && now - cached.at < FOLDER_SESSION_SUMMARY_TTL_MS) continue;
      if (folderSummaryFetchingRef.current.has(folderId)) continue;
      folderSummaryFetchingRef.current.add(folderId);
      projectsApi.sessions(folderId)
        .then((r) => {
          setFolderSessionSummaries((prev) => new Map(prev).set(folderId, { at: Date.now(), summary: summarizeFolderSessions(r.sessions) }));
        })
        .catch(() => {
          setFolderSessionSummaries((prev) => new Map(prev).set(folderId, { at: Date.now(), summary: null }));
        })
        .finally(() => { folderSummaryFetchingRef.current.delete(folderId); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedProjects, user?.id, folderSummaryVersion]);
  // Sub-session grouping (chat-lineage): parent chats whose nested child rows
  // are collapsed in the sidebar (the parent row then shows a hidden count).
  const [collapsedChatParents, setCollapsedChatParents] = useState<Set<string>>(new Set());
  const toggleChatChildren = useCallback((parentId: string) => {
    setCollapsedChatParents(prev => {
      const next = new Set(prev);
      if (next.has(parentId)) next.delete(parentId); else next.add(parentId);
      return next;
    });
  }, []);
  const [chatsSectionCollapsed, setChatsSectionCollapsed] = useState(false);
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  // Audit 2026-07-16: the coding-project ImportDialog was lost with the code
  // page — restored as a component, opened from the New Folder dialog.
  const [showImportProjectDialog, setShowImportProjectDialog] = useState(false);
  // Deep search across all chats + messages (ticket 4fd1de3c) — command-palette
  // dialog opened from the sidebar search button or ⌘K / Ctrl+K.
  const [deepSearchOpen, setDeepSearchOpen] = useState(false);
  // Per-chat autonomy editor (ticket ba733210) — opened from the ⋯ menu.
  const [autonomyChatId, setAutonomyChatId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectEmoji, setNewProjectEmoji] = useState('📁');
  const [newProjectParentId, setNewProjectParentId] = useState<string | ''>('');
  const [creatingProject, setCreatingProject] = useState(false);

  // ── Current project context ───────────────────────────────────────────────
  // null = no project, string = chatting within this project
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [currentProjectName, setCurrentProjectName] = useState<string | null>(null);

  // ── Share chat state ──────────────────────────────────────────────────────
  const [shareChatId, setShareChatId] = useState<string | null>(null);
  const [shareChatUrl, setShareChatUrl] = useState<string | null>(null);
  const [loadingShare, setLoadingShare] = useState(false);
  const [copiedShareUrl, setCopiedShareUrl] = useState(false);

  // ── Move to project state ─────────────────────────────────────────────────
  const [movingChatId, setMovingChatId] = useState<string | null>(null);
  const [movingToProjectId, setMovingToProjectId] = useState<string | ''>('');

  // ── Canvas state ──────────────────────────────────────────────────────────
  const [canvases, setCanvases] = useState<CanvasItem[]>([]);
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  // THE right-panel open state — page-owned for EVERY session kind (plain,
  // coding, chatless); CodeSessionView receives it as controlled props. One
  // state, one ⋯-menu "Side panel" toggle, persists across chat switches.
  const [panelOpen, setPanelOpen] = useState(false);
  // Digby Frontier (2026-10-06): opening the side panel (canvas / files /
  // settings) on a desktop narrower than 1280px collapses the sidebar so the
  // chat keeps its 380px minimum — the panel and rail never squeeze it.
  const panelWasOpenRef = useRef(false);
  useEffect(() => {
    const opened = panelOpen && !panelWasOpenRef.current;
    panelWasOpenRef.current = panelOpen;
    if (!opened || typeof window === 'undefined') return;
    if (window.innerWidth >= RAIL_BREAKPOINT_PX && window.innerWidth < PANEL_AUTOCOLLAPSE_BELOW_PX) {
      setSidebarOpen(false);
    }
  }, [panelOpen, setSidebarOpen]);
  // Per-chat Files panel (57ef1b9f PR2): bumped when a message send completes
  // so ChatFilesSection refetches and an upload the user just sent appears —
  // and (2026-09-24) any image generate_image saved this turn, since the
  // Files tab's "Created by Digby" rows are what the transcript's Download /
  // Open actions point at. The bump rides handleCodeRunning (running→false),
  // the page's only view of a plain run finishing (idiom: CodeSessionView's
  // own setFilesRefreshKey on its `complete` frame).
  const [chatFilesRefreshKey, setChatFilesRefreshKey] = useState(0);
  // One-Digby C3: when set, the main column renders the converged session view
  // (transcript + composer + side panel) instead of the chat thread.
  const [codeChatId, setCodeChatId] = useState<string | null>(null);
  // Inline confirm cards (ticket cbdb4614): the OPEN chat's live staged
  // consequential-tool confirmations — handed to CodeSessionView so the card
  // renders in-flow at the bottom of the transcript (where the user is
  // looking), not only in the collapsed sidebar rail. useMemo keeps a stable
  // identity for CodeSessionView's prop-effect discipline (the "Stable
  // identities for CodeSessionView props" note further down this file).
  const openChatPendingConfirmations = useMemo(
    () => selectLiveChatConfirmations(pendingConfirmations, codeChatId),
    [pendingConfirmations, codeChatId],
  );
  // Owner 2026-09-22: the open chat's flagged owner questions render in-flow as
  // an answerable card too — the rail link used to land on a chat with nothing
  // to act on.
  const openChatOwnerQuestions = useMemo(
    () => selectLiveChatOwnerQuestions(pendingConfirmations, codeChatId),
    [pendingConfirmations, codeChatId],
  );
  // The composer message that created the session — handed to CodeSessionView
  // to auto-start the first run, then cleared.
  const [codeInitialMessage, setCodeInitialMessage] = useState<string | null>(null);
  const [codeInitialImages, setCodeInitialImages] = useState<ChatImage[]>([]);
  // C3 blocker 1 (ticket 71b1fec6): clean bubble text for the initial PLAIN
  // hand-off send — legacy displayContent semantics (news follow-ups display a
  // short label, send a long prompt). Cleared with codeInitialMessage.
  const [codeInitialDisplay, setCodeInitialDisplay] = useState<string | null>(null);
  // Floating-chrome state pushed up by the mounted CodeSessionView (branch,
  // publish/mode/panel actions) — rendered into the ⋯ menu by FloatingChrome.
  const [codeChrome, setCodeChrome] = useState<CodingChrome | null>(null);
  /** P2: the chat mounted in CodeSessionView is a PLAIN chat (no satellite) —
      the view runs its plain mode (plain-session.ts). */
  const [codeChatPlain, setCodeChatPlain] = useState(false);
  // C3 (ticket 71b1fec6): chatId-less converged-view mounts. guest=true is the
  // anonymous GUEST mode (very limited features + sign-up CTAs — owner
  // directive); guest=false is the signed-in createChat-failure FALLBACK (full
  // composer features, ephemeral/unsaved, no re-attach). nonce keys the mount
  // so a later chatless send after navigating home remounts fresh.
  // ghost (2026-10-22): the fallback inherits the home composer's ARMED ghost
  // posture — no row exists to carry it, so the view sends ghost=true per send.
  const [chatless, setChatless] = useState<{ guest: boolean; nonce: number; ghost?: boolean } | null>(null);
  // A coded mount (codeChatId set) always wins over a lingering chatless one —
  // loadChat need not clear it (startNewChat does).
  const chatlessActive = codeChatId ? null : chatless;
  // Guest sessions (feedback ticket 63bb607f): browser-local, non-durable
  // history for ANONYMOUS users. localStorage is the source of truth; this
  // list is its post-mount hydrated mirror (SSR-safe — no hydration
  // mismatch). activeGuestId names the OPEN conversation — its UUID is also
  // the server-side cm_session context key, threaded through the chatId-less
  // stream URL so a reopened guest session keeps its 24h server-side memory.
  const [guestSessions, setGuestSessions] = useState<GuestSessionRecord[]>([]);
  const [activeGuestId, setActiveGuestId] = useState<string | null>(null);
  // Ghost mode (2026-10-22): per-GUEST-SESSION flag (browser-local, alongside
  // the guest-session store pattern — localStorage is the source of truth and
  // this mirror hydrates post-mount, SSR-safe). Driving the view's send path
  // through a getter (plain.ghostActive) means a mid-conversation flip
  // applies to the NEXT send without remounting anything.
  const [guestGhost, setGuestGhostState] = useState(false);
  // Ghost composer toggle (2026-10-22, SIGNED-IN; lib/ghost-composer.ts): on
  // HOME the toggle ARMS ghost for the chat the next send creates (consumed by
  // that createChat — ghostMode:true rides POST /chats so the FIRST message is
  // already private). The ref mirror keeps handleSendMessageInner's identity
  // stable (the news-prompt effect depends on it).
  const [newChatGhost, setNewChatGhostState] = useState(false);
  const newChatGhostRef = useRef(false);
  const setNewChatGhost = useCallback((on: boolean) => {
    newChatGhostRef.current = on;
    setNewChatGhostState(on);
  }, []);
  // An open chat's flip is in flight (the toggle dims; a second click is ignored).
  const [chatGhostSaving, setChatGhostSaving] = useState(false);
  const chatGhostSavingRef = useRef(false);
  // A just-saved ghost flip per chat, held against a STALE sidebar row (a
  // /chats/changes or full list the server built before the PUT, landing after
  // it, used to put the old posture back on the toggle / badge / panel switch
  // until the next delta) — lib/ghost-composer.ts holdPendingGhostFlips.
  // Recorded only while the composer toggle is on (=1 is the pre-toggle page).
  const pendingGhostRef = useRef<Map<string, PendingGhostFlip>>(new Map());
  const noteGhostFlip = useCallback((chatId: string, value: boolean, saved?: unknown) => {
    if (ghostComposerToggleDisabled()) return;
    const at = saved && typeof saved === 'object' ? (saved as { updatedAt?: unknown }).updatedAt : undefined;
    pendingGhostRef.current.set(chatId, { value, updatedAt: typeof at === 'string' ? at : null, at: Date.now() });
  }, []);
  /** Incoming list rows with every pending ghost flip held (and the settled holds dropped). */
  const holdGhostRows = useCallback(<T extends { id: string; ghostMode?: boolean; updatedAt?: unknown }>(rows: T[]): T[] => {
    const held = holdPendingGhostFlips(rows, pendingGhostRef.current, Date.now());
    for (const id of held.settled) pendingGhostRef.current.delete(id);
    return held.rows;
  }, []);
  // Ref mirrors for async guards (the reconcile poll / send-path checks)
  // that must know whether the unified view currently owns a plain chat's
  // stream without re-firing their useCallback identities (P2 increment 2).
  const codeChatIdRef = useRef<string | null>(null);
  const codeChatPlainRef = useRef(false);
  useEffect(() => { codeChatIdRef.current = codeChatId; codeChatPlainRef.current = codeChatPlain; });

  // (The legacy foreground EventSource + its timing refs retired with the
  // in-page transcript — C3. The converged view owns every stream now.)
  // Viewport/content refs for the home ScrollArea (the legacy transcript's
  // pin-to-bottom scroll apparatus retired with it — C3).
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const chatContentRef = useRef<HTMLDivElement>(null);
  const currentChatIdRef = useRef<string | null>(null);

  // Attention dots: bump to recompute unread dots (chatHasUnread reads
  // localStorage during render) when a marker changes outside a chat switch.
  const [, setViewedTick] = useState(0);

  // Keep the OPEN chat's viewed-marker fresh while the tab is visible — covers
  // both views (CodeSessionView streams outside page message state), so a reply
  // you're watching never flags unread; on refocus, recompute dots immediately.
  useEffect(() => {
    const mark = () => {
      const id = currentChatIdRef.current;
      if (id && document.visibilityState === 'visible') writeChatViewed(id);
    };
    const iv = setInterval(mark, 5000);
    const onVisible = () => { mark(); setViewedTick(t => t + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  const currentProjectIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Voice input (0c256c3a): the shared hook owns the mic lifecycle — every
  // send/queue/commit path below calls discardRecording() so the just-sent
  // text is never re-injected into the cleared composer.
  const { isRecording, isTranscribing, toggleRecording: handleMicClick, discardRecording } = useVoiceComposer({ composerRef, textareaRef });
  // Live draft-length tracking for the near-limit counter (ticket 4b7a32b1)
  // WITHOUT re-rendering the page on every keystroke: a native input listener
  // only produces a state CHANGE inside the warning zone (or when leaving it —
  // React bails on identical values). Programmatic setValue/clear fire no
  // 'input' event; the send/queue paths reset the counter explicitly after
  // clearing. Re-keyed on codeChatId because the composer unmounts while a
  // coding session (CodeSessionView) is open and remounts on return — the
  // listener must re-attach to the fresh <textarea>. (Mirrors SupervisorChatTab.)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const onInput = () => {
      const len = el.value.length;
      setCharCount(len >= NEAR_LIMIT_CHAT_CHARS ? len : 0);
    };
    el.addEventListener('input', onInput);
    return () => el.removeEventListener('input', onInput);
  }, [codeChatId]);
  // Background streaming: chats generating while user has navigated away
  const [generatingChatIds, setGeneratingChatIds] = useState<Set<string>>(new Set());
  // Server-truth reconciliation for coding-run spinners: ids the backend reports
  // as running (polled) + per-id local-mark timestamps for the start-race grace
  // window. A coding run finishing while its CodeSessionView is unmounted (or
  // its SSE died in a backgrounded PWA) must not leave the sidebar spinning forever.
  const [codingRunningIds, setCodingRunningIds] = useState<Set<string>>(new Set());
  const codingRunMarkedAt = useRef<Map<string, number>>(new Map());
  // Sidebar spinner truth: local marks (instant feedback; the only source for
  // regular chats) ∪ server-reported running coding sessions.
  const effectiveGeneratingIds = useMemo(
    () => new Set([...generatingChatIds, ...codingRunningIds]),
    [generatingChatIds, codingRunningIds],
  );
  const bgEventSourcesRef = useRef<Map<string, EventSource>>(new Map());
  // (C3 deletion pass, §5b: the re-attach banner, its server-truth pruning
  // effect, and the bg-chat state snapshots are gone — they served signed-in
  // chats rendered on the legacy transcript, a class that no longer exists.
  // The unified view owns attach/re-attach for every stored chat.)
  // Pending news prompt — set when a news follow-up button is clicked, consumed after startNewChat() clears messages
  const pendingNewsPromptRef = useRef<string | null>(null);
  const pendingNewsDisplayRef = useRef<string | null>(null);
  // Trigger counter — bumped by handleNewsFollowUp to force the pending-news useEffect to re-run
  // even when messages.length is already 0 (home screen, no active chat)
  const [newsTrigger, setNewsTrigger] = useState(0);
  // Stable ref to owned projects (for project name lookup in loadChat)
  const ownedProjectsRef = useRef<Project[]>([]);

  // Keep refs in sync with state (avoids stale closure in EventSource callbacks)
  useEffect(() => { currentChatIdRef.current = currentChatId; }, [currentChatId]);
  useEffect(() => { currentProjectIdRef.current = currentProjectId; }, [currentProjectId]);
  useEffect(() => { ownedProjectsRef.current = ownedProjects; }, [ownedProjects]);

  // Persist the folder tree's expanded/collapsed state.
  useEffect(() => {
    try { localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify([...expandedProjects])); } catch {}
  }, [expandedProjects]);

  // ── Folder tree (P2) ──────────────────────────────────────────────────────
  // Sidebar folder lists hide fleet-dedicated project folders (they live under
  // /management instead) AND the owner's hidden user-space project (User Space
  // P3, spec §5: every chat auto-files into it; its chats render as the
  // ungrouped section below via userSpaceId, so the sidebar looks EXACTLY as
  // it did pre-user-space). folderTree — and flatFolders, which derives from
  // it — excludes them too, so the sidebar, the folder pickers, and the
  // drag-end depth pre-check never offer a hidden folder (intentional: nothing
  // should be filed into one by hand; the server re-checks moves
  // authoritatively). Direct `ownedProjects` consumers (settings dialogs)
  // still see the full list.
  const userSpaceId = useMemo(() => ownedProjects.find((p) => p.isUserSpace)?.id, [ownedProjects]);
  // Archived folders leave the tree too (server already excludes them; the
  // local filter makes an optimistic archive patch drop the folder instantly).
  // Framework surface (ticket 9471d338): the platform's own project leaves the
  // sidebar entirely — Management → Framework is its home (identity = the
  // repoUrl, stamped server-side as isFrameworkProject; the fleetHidden belt
  // covers a backend still on the old shape).
  const visibleProjects = useMemo(() => ownedProjects.filter((p) => !p.isUserSpace && !p.archivedAt && !p.isFrameworkProject && !fleetHidden.projectIds.has(p.id)), [ownedProjects, fleetHidden]);

  // Ticket 7acaa7ba: shared folders join the sidebar TREE. Before this the
  // tree was built from owned projects only, so a project member saw the
  // folder only as a flat "Shared with me" row with no chats nested — while
  // listChats (backend) already returns member-project chats. Shared folders
  // render with a shared badge, are NOT drag/drop targets (disabled FolderRowDnd),
  // and their chats nest exactly like owned ones (client-side projectId filter).
  const treeProjects = useMemo(
    () => [
      ...visibleProjects.map((p) => ({ ...p, isSharedFolder: false })),
      // Reviewer F5 guard: a legacy member row on a project the user ALSO owns
      // would render two nodes with the same key — the owned row wins.
      ...sharedProjects
        .filter((p) => !p.archivedAt && !fleetHidden.projectIds.has(p.id) && !visibleProjects.some((o) => o.id === p.id))
        .map((p) => ({ ...(p as Project), isSharedFolder: true })),
    ],
    [visibleProjects, sharedProjects, fleetHidden],
  );
  const sharedFolderIds = useMemo(() => new Set(treeProjects.filter((p) => p.isSharedFolder).map((p) => p.id)), [treeProjects]);

  // Built client-side from the flat list via parentId. Order within each level
  // preserves the API order (updatedAt desc) — same ordering the flat list had.
  // treeDepth is derived here (not trusted from state) so optimistic moves
  // re-render at the right depth immediately.
  const folderTree = useMemo<FolderNode[]>(() => {
    const ids = new Set(treeProjects.map((p) => p.id));
    const byParent = new Map<string | null, Project[]>();
    for (const p of treeProjects) {
      // A dangling parentId (parent missing from the list) is treated as root —
      // for a shared SUBFOLDER whose parent the viewer isn't a member of, that
      // promotes it to a top-level node (visible, not silently dropped).
      const key = p.parentId && ids.has(p.parentId) ? p.parentId : null;
      const arr = byParent.get(key);
      if (arr) arr.push(p);
      else byParent.set(key, [p]);
    }
    const build = (parentKey: string | null, depth: number, ancestors: Set<string>): FolderNode[] =>
      (byParent.get(parentKey) ?? []).map((p) => ({
        ...p,
        treeDepth: depth,
        // Cycle guard: a folder already in its own ancestor chain stops recursing.
        children: ancestors.has(p.id) ? [] : build(p.id, depth + 1, new Set([...ancestors, p.id])),
      }));
    return build(null, 0, new Set());
  }, [treeProjects]);

  // Flattened DFS view of the tree — used by the parent pickers + drag-end checks.
  // 7acaa7ba: SHARED folders are filtered OUT of this list on purpose — the
  // render tree nests them (visible + chats), but the New-Folder parent picker
  // and Move-to-Folder dialog keep offering only folders the user OWNS: a
  // member-created subfolder under an owner's folder would be invisible to the
  // folder's owner (getFolderTree.owned is userId-scoped), and moving one's own
  // chat into a shared folder hides it from the owner's sidebar the same way.
  const flatFolders = useMemo<FolderNode[]>(() => {
    const out: FolderNode[] = [];
    const walk = (nodes: FolderNode[]) => nodes.forEach((n) => { if (!n.isSharedFolder) { out.push(n); walk(n.children); } });
    walk(folderTree);
    return out;
  }, [folderTree]);

  /** Breadcrumb chain root→…→folder for a folder id (client-side, from the flat list). */
  const getFolderPath = useCallback((folderId: string | null): Project[] => {
    if (!folderId) return [];
    const byId = new Map(ownedProjects.map((p) => [p.id, p]));
    const chain: Project[] = [];
    let cur = byId.get(folderId);
    let guard = 0;
    while (cur && guard++ <= MAX_FOLDER_DEPTH + 1) {
      chain.unshift(cur);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain;
  }, [ownedProjects]);

  // ── Sidebar drag-and-drop (P2) ────────────────────────────────────────────
  const [activeDrag, setActiveDrag] = useState<SidebarDragItem | null>(null);
  const sidebarSensors = useSensors(
    // Mouse: 6px movement starts a drag (row clicks/expand toggles still fire).
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Touch: a drag starts only after a 250ms press-and-hold, and cancels if
    // the finger moves >8px during that window — a scroll swipe moves
    // immediately, so it scrolls natively and NEVER initiates a drag (owner
    // report: scrolling the mobile sidebar kept dragging rows into folders).
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor)
  );


  // Browser geolocation was REMOVED 2026-10-16 (site review): the app's own
  // Permissions-Policy (`geolocation=()`, next.config.ts) blocks it, so both
  // effects only logged a policy violation on every load — and a working one
  // would have sent coordinates to OpenStreetMap, outside Canada. Guests and
  // signed-in users get an approximate location from the server's IP lookup.

  // Auth bootstrap (2026-10-09 Windows-shell hang fix): a transient /auth/me
  // failure used to fail SOFT (keep the token, console.warn, render the
  // ANONYMOUS home) — on a laptop resuming from sleep or a wedged proxy, a
  // signed-in user opened the app to a signed-out-looking home with the
  // perpetually-spinning hat and NO way to know their session was intact.
  // Now: up to 3 bounded retries (the api client now has a 45s timeout — a
  // hung request rejects instead of never settling), and if all fail the
  // session stays intact but a visible "couldn't reach Digby" banner offers
  // Retry — never a silent signed-out look.
  const [authBootFailed, setAuthBootFailed] = useState(false);
  const authBootRetriedRef = useRef(0);
  const runAuthBootstrap = useCallback(() => {
    const hadToken = !!localStorage.getItem('accessToken');
    authApi.getCurrentUser()
      .then((u) => {
        setAuthBootFailed(false);
        setUser(u);
      })
      .catch((err) => {
        // 05303f58: only a definitive 401 (the api client already tried the
        // refresh) ends the session — a network blip/5xx keeps the token and
        // fails soft instead of bouncing a signed-in user to /login.
        if (!isDefinitiveAuthFailure(err)) {
          // Bounded retry (3 attempts, 2s apart), then the honest banner —
          // never the silent anonymous-home look for a signed-in user.
          if (authBootRetriedRef.current < 3) {
            authBootRetriedRef.current += 1;
            setTimeout(() => runAuthBootstrap(), 2000);
            return;
          }
          console.warn('getCurrentUser failed (non-auth) — keeping the session', err);
          if (hadToken) setAuthBootFailed(true);
          return;
        }
        setUser(null);
        setAccessToken(null);
        // Defensive (review finding, 2026-11-04): the session is definitively
        // over, so drop the module-scoped chat data now rather than relying on
        // the follow-up login being a full-document navigation. Makes the
        // "no cross-account first paint" guarantee local instead of dependent
        // on routing internals.
        chatListCache.clear();
        if (hadToken) {
          localStorage.removeItem('accessToken');
          toast.error('Your session expired. Please sign back in.', {
            duration: 6000,
            action: { label: 'Sign in', onClick: () => router.push('/login') },
          });
        }
      });
  }, [router]);

  useEffect(() => {
    // 6201e0ee: the chat-events SSE subscription rides this same token state.
    try { setAccessToken(localStorage.getItem('accessToken')); } catch { /* storage blocked */ }
    runAuthBootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot bootstrap by design: retries re-run runAuthBootstrap itself, not this effect.
  }, []);

  // Fetch deep research quota when user is available
  useEffect(() => {
    if (!user || isKid) { setDeepResearchQuota(null); return; }
    deepResearchApi.getQuota()
      .then(setDeepResearchQuota)
      .catch(() => {}); // fail silently
  }, [user]);

  // Kid accounts: localStorage prefs are per-browser, so a kid can inherit a
  // parked legacy 'code' mode from a parent's session (pre-P4). The level
  // control and workspace surfaces are hidden for kids — snap the mode back so
  // their sends never route near the coding surface. (Kids CAN land on Auto —
  // the server forces the kid pipeline regardless of the requested mode.)
  useEffect(() => {
    if (isKid && mode === 'code') {
      setMode('single_thinking');
      update({ patienceMode: 'single_thinking' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isKid, mode]);


  // Fetch personalized news headlines for the home screen.
  // The backend returns instantly: either cached headlines or { pending: true }
  // when a background fetch is in progress. We poll every 6s while pending
  // so the user sees news as soon as the backend has it ready.
  // Honest degraded state (ticket d86cf931): poll outcomes feed the
  // lib/news-polling state machine — after sustained failures (or when the API
  // itself reports degraded/backoff) the card admits "temporarily unavailable"
  // and backs off to a 60s cadence instead of claiming "checking every few
  // seconds" forever (the 2026-08-29 ~6h outage lie). First success restores
  // the live state.
  // News staleness: backend refreshes cache at 6am/12pm/4pm/9pm, but the
  // frontend must also re-fetch periodically so users don't see yesterday's news.
  const newsPollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newsAutoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const newsLastFetchedRef = useRef<number>(0);
  const newsPollStateRef = useRef<NewsPollState>({ ...INITIAL_NEWS_POLL_STATE });
  const [newsDegraded, setNewsDegraded] = useState(false);
  // Self-host setup hardening (2026-10-20): this instance has no web search, so a
  // briefing can never be built — say so once, never poll.
  const [newsUnconfigured, setNewsUnconfigured] = useState(false);
  // 2026-10-26: which pipeline piece is missing — drives the honest copy
  // ('search' vs 'formatter' name different admin fixes).
  const [newsUnconfiguredReason, setNewsUnconfiguredReason] = useState<'search' | 'formatter' | null>(null);
  // What THIS instance has configured (null until known; a failed read changes nothing).
  const [instanceSetup, setInstanceSetup] = useState<InstanceSetup | null>(null);
  useEffect(() => {
    if (!user) return;
    instanceSetupApi.get().then(setInstanceSetup).catch(() => { /* unknown ⇒ render as today */ });
  }, [user]);
  const NEWS_STALE_MS = 30 * 60 * 1000;       // 30 min — re-fetch on tab focus if older
  const NEWS_AUTO_REFRESH_MS = 60 * 60 * 1000; // 60 min — auto-refresh for always-open tabs

  // Feed one poll outcome into the state machine; returns the next poll delay.
  const applyNewsOutcome = (outcome: NewsPollOutcome): number => {
    const next = nextNewsPoll(newsPollStateRef.current, outcome);
    newsPollStateRef.current = next.state;
    setNewsDegraded(next.state.degraded);
    return next.delayMs;
  };

  // Stop the poll chain and restore the healthy live state (on real headlines).
  const resetNewsPolling = () => {
    if (newsPollingRef.current) {
      clearTimeout(newsPollingRef.current);
      newsPollingRef.current = null;
    }
    newsPollStateRef.current = { ...INITIAL_NEWS_POLL_STATE };
    setNewsDegraded(false);
  };

  // (Re-)schedule the next poll. The poll body: headlines → reset + stop;
  // anything else → feed the state machine and continue at its cadence.
  const scheduleNewsPoll = (delayMs: number) => {
    if (newsPollingRef.current) clearTimeout(newsPollingRef.current);
    newsPollingRef.current = setTimeout(async () => {
      newsPollingRef.current = null; // the timeout that called us has fired
      try {
        const poll = await newsApi.getHeadlines();
        if (poll.headlines.length > 0) {
          setNewsHeadlines(poll.headlines);
          newsLastFetchedRef.current = Date.now();
          resetNewsPolling(); // success — stop the chain, restore live state
          return;
        }
        scheduleNewsPoll(applyNewsOutcome(poll.degraded ? 'degraded' : 'pending'));
      } catch {
        scheduleNewsPoll(applyNewsOutcome('error'));
      }
    }, delayMs);
  };

  // Start polling if not already running (initial fetch said pending/degraded,
  // or a terminal fetch failure — the card must keep probing, honestly).
  const startNewsPollChain = () => {
    if (newsPollingRef.current) return;
    scheduleNewsPoll(NEWS_POLL_HEALTHY_MS);
  };

  const fetchNewsWithRetry = useCallback(async (retryCount = 0) => {
    if (!user || isKid) { setNewsHeadlines([]); return; }
    // Only show loading spinner on first attempt (not retries)
    if (retryCount === 0) setNewsLoading(true);
    try {
      const result = await newsApi.getHeadlines();
      setNewsHeadlines(result.headlines);
      // If we got headlines, stop any polling and record fetch time
      if (result.headlines.length > 0) {
        // Reset read/expanded state when content actually changes (stale refresh)
        const isStaleRefresh = newsLastFetchedRef.current > 0 &&
          Date.now() - newsLastFetchedRef.current > NEWS_STALE_MS;
        if (isStaleRefresh) {
          setReadNewsIndices(new Set());
          setExpandedNewsIndices(new Set());
        }
        newsLastFetchedRef.current = Date.now();
        resetNewsPolling();
      } else {
        // No headlines: a degraded response flips the card to its honest
        // unavailable state immediately; then keep probing via the poll chain.
        if (result.unconfigured) {
          // The instance can never build a briefing (search or formatter
          // missing) — a terminal state, not an outage. Remember WHICH piece
          // so the copy names the right admin fix.
          setNewsUnconfigured(true);
          setNewsUnconfiguredReason(result.unconfiguredReason ?? 'search');
          return;
        }
        if (result.degraded) applyNewsOutcome('degraded');
        if (result.pending || result.degraded) {
          startNewsPollChain();
        } else if (retryCount < 3) {
          // Not pending but empty (rare — maybe the LLM failed). Retry a few times.
          const delays = [10000, 20000, 40000];
          setTimeout(() => fetchNewsWithRetry(retryCount + 1), delays[retryCount]);
        } else {
          // Terminal empty — keep probing honestly via the poll chain rather
          // than showing "being prepared" with nothing actually polling.
          startNewsPollChain();
        }
      }
    } catch {
      // On error, retry up to 2 times — then hand off to the poll chain so the
      // card keeps probing at a backed-off cadence and degrades honestly.
      if (retryCount < 2) {
        setTimeout(() => fetchNewsWithRetry(retryCount + 1), 10000);
      } else {
        startNewsPollChain();
      }
    } finally {
      setNewsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll helpers are ref/setState-only closures; first-render capture is safe.
  }, [user]);

  useEffect(() => {
    fetchNewsWithRetry(0);

    // Auto-refresh every 60 min so always-open tabs get fresh news
    newsAutoRefreshRef.current = setInterval(() => {
      fetchNewsWithRetry(0);
    }, NEWS_AUTO_REFRESH_MS);

    return () => {
      if (newsPollingRef.current) {
        clearTimeout(newsPollingRef.current);
        newsPollingRef.current = null;
      }
      if (newsAutoRefreshRef.current) {
        clearInterval(newsAutoRefreshRef.current);
        newsAutoRefreshRef.current = null;
      }
    };
  }, [fetchNewsWithRetry]);

  // Re-fetch news when user returns to the tab if news is stale (>30 min old)
  // or missing. The backend scheduler refreshes Redis cache 4x/day, so a
  // returning user should almost always get fresh headlines on re-focus.
  useEffect(() => {
    if (!user) return;
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const isStale = Date.now() - newsLastFetchedRef.current > NEWS_STALE_MS;
      if (newsHeadlines.length === 0 || isStale) {
        fetchNewsWithRetry(0);
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [user, newsHeadlines.length, fetchNewsWithRetry]);

  // Fetch calendar events for the home screen (runs alongside news). Also the
  // Today card's Retry (2026-10-21).
  const loadCalendar = useCallback(() => {
    if (!user || isKid) { setCalendarEvents([]); setCalendarConnected(false); setCalendarError(null); setCalendarApple(null); return; }
    setCalendarLoading(true);
    calendarApi.getTodayEvents()
      .then((data) => {
        setCalendarConnected(data.connected);
        setCalendarEvents(data.events || []);
        setCalendarError(data.error ?? null);
        setCalendarApple(data.apple ?? null);
      })
      .catch(() => { setCalendarError('unavailable'); }) // non-critical — but say so on the card, never vanish
      .finally(() => setCalendarLoading(false));
  }, [user, isKid]);
  useEffect(() => { loadCalendar(); }, [loadCalendar]);

  // Re-evaluate past/future calendar events every 60 seconds (so events grey out in real-time)
  useEffect(() => {
    if (!calendarConnected || calendarEvents.length === 0) return;
    const timer = setInterval(() => setCalendarTick(t => t + 1), 60_000);
    return () => clearInterval(timer);
  }, [calendarConnected, calendarEvents.length]);

  // Fetch personalized starter questions for the home screen. On cache miss the
  // backend returns the generic defaults with pending=true and generates in the
  // background — re-fetch so the tailored set swaps in. Budget ~140s (14×10s;
  // was 8×8s, feedback 93fa84af): since 2026-09-08 generation is TWO reasoning
  // passes (draft + critic, thinking on) that can outlast the old ~64s window,
  // and a set that only lands on the next visit reads as "not personalized".
  useEffect(() => {
    if (!user || isKid) { setSuggestedQuestions(DEFAULT_STARTER_QUESTIONS); return; }
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const fetchQuestions = (attempt: number) => {
      suggestionsApi.getStarterQuestions()
        .then((data) => {
          if (cancelled) return;
          if (data.questions.length > 0) setSuggestedQuestions(data.questions);
          // 2026-10-26 (self-host honesty): unconfigured = the instance can
          // never generate a personalized set (no utility LLM) — defaults are
          // the real answer, not a placeholder. Stop; polling re-fetches a
          // pipeline that cannot succeed for ~140s on every home visit.
          if (data.unconfigured) return;
          if (data.pending && attempt < 14) {
            timers.push(setTimeout(() => fetchQuestions(attempt + 1), 10000));
          }
        })
        .catch(() => {}); // fail silently — defaults are already showing
    };
    fetchQuestions(0);
    return () => { cancelled = true; timers.forEach(clearTimeout); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, isKid]);

  // Fetch the user's location + current weather for the home screen header.
  // Backend resolves location from user memory; { available: false } hides the
  // line. usePolling (P5): immediate fetch on sign-in + 30-min refresh for
  // always-open tabs (matches backend cache TTL), abortable ticks, silent
  // failures (weather is a nice-to-have). pauseWhenHidden:false preserves the
  // legacy always-on cadence.
  useEffect(() => { if (!user || isKid) setHomeWeather(null); }, [user, isKid]);
  usePolling(
    (signal) => weatherApi.getWeather({ signal }),
    {
      intervalMs: 30 * 60 * 1000,
      enabled: !!user && !isKid,
      pauseWhenHidden: false,
      onData: setHomeWeather,
    },
  );

  // Reconcile coding-run spinners against server truth. The local
  // generatingChatIds mark is mount-scoped: a run that finishes while its
  // CodeSessionView is unmounted (or its SSE died in a backgrounded PWA) would
  // otherwise spin forever. Poll the backend's running-ids — fast (8s) while a
  // coding spinner is visible, slow (60s) when idle so runs started on another
  // tab/device/scheduler surface too — and prune local marks the server says
  // are finished (15s grace covers the POST /run roundtrip; re-stamped on
  // confirm in CodeSessionView.send).
  const anyCodingSpinner = chats.some(c => c.mode === 'code' && effectiveGeneratingIds.has(c.id));
  // P5 feedback-loop fix: this poll used to be a setInterval effect with
  // `chats` in its dependency array (the tick reads chat modes) — every
  // setChats (title updates, reorders, message commits, streaming) tore the
  // interval down, re-created it AND fired an immediate refetch, so the
  // "8s/60s" poll effectively ran on every chats churn. The tick now reads the
  // latest chats through a ref, usePolling keeps the interval stable (cadence
  // flips re-arm in place, no leading refetch), and every tick is abortable so
  // a slow listRunning response can never overwrite a newer one.
  const chatsRef = useRef(chats);
  useEffect(() => { chatsRef.current = chats; }, [chats]);

  // Sidebar live refresh (ticket d6b2eef5): the chat list was mount-only, so a
  // session a supervisor spawned (or a rename / re-parent / folder move made
  // elsewhere) never appeared until a reload. Poll GET /chats/changes with the
  // newest updatedAt seen as the watermark (chatsSinceRef — reset by every full
  // fetchChatList), on the running-reconcile's cadence (15 s while a coding
  // spinner is visible — a spawn is imminent — 60 s idle; paused hidden, a
  // catch-up tick on focus), and merge: known rows refresh IN PLACE (transcript
  // kept, position kept — never a jump under the reader), unknown rows are
  // prepended. Rows arrive lineage-completed (the parent rides with the child),
  // so nesting is right the moment a spawned session lands. The running
  // reconcile below kicks an immediate delta when it sees a running id the
  // sidebar has no row for.
  const chatsSinceRef = useRef<string | null>(null);
  const liveKickedIds = useRef(new Set<string>());

  // Owner 2026-10-27 (stale-list sweep — explorer findings A+B): the sidebar's
  // FOLDER state (ownedProjects counts/names + the per-folder lane summary
  // line) had no invalidation on chat removal: archive/delete patched `chats`
  // only, so the folder's count badge kept the old number; a REMOTE mutation
  // (spawn wave, move, archive elsewhere) never refreshed folders at all (the
  // SSE vocabulary and the delta poll are chat-row scoped). ONE coalesced
  // refresh — projectsApi.list() + a folder-summary cache age-out — called by
  // every path that creates/archives/deletes/moves a chat, locally or via SSE
  // notice. Trailing-debounced (1.5 s): spawn waves burst notices and one list
  // call serves them all. Counts are cosmetic — every failure fails open.
  const folderRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (folderRefreshTimerRef.current) clearTimeout(folderRefreshTimerRef.current); }, []);
  const refreshFolderLists = useCallback(() => {
    if (folderRefreshTimerRef.current) clearTimeout(folderRefreshTimerRef.current);
    folderRefreshTimerRef.current = setTimeout(() => {
      folderRefreshTimerRef.current = null;
      projectsApi.list().then(({ owned, shared }) => {
        setOwnedProjects(owned);
        setSharedProjects(shared);
      }).catch(() => {});
      // Age every cached summary to 0 (keep the stale line rendered while the
      // refetch flies — no flicker) so the summary effect's TTL check refetches.
      setFolderSessionSummaries(prev => {
        const next = new Map<string, { at: number; summary: FolderSessionSummary | null }>();
        for (const [k, v] of prev) next.set(k, { ...v, at: 0 });
        return next;
      });
      setFolderSummaryVersion(v => v + 1);
    }, 1500);
  }, []);

  // ── Deleted-chat view clearing (owner 2026-10-27: "when you delete a chat or
  // a session it doesn't go away but still sits in the chat if you have it
  // open") — the ONE shared handler for every path that removes a chat row the
  // user may be LOOKING at: the sidebar delete button, the archive action, and
  // the SSE `chat.deleted` notice (a delete from another tab / device / lane).
  // The row itself is dropped from `chats` by each caller (optimistic setChats
  // — every sidebar surface derives from it); what this owns is the OPEN VIEW:
  // clearing `codeChatId`/`codeChatPlain` unmounts CodeSessionView (keyed by
  // `chatId:flavor`), so the main column falls back to the home composer
  // instead of a dead panel streaming a chat that no longer exists. Also clears
  // `sessionId` (legacy) and `codeChrome` (floating-chrome state pushed by the
  // now-unmounted view — never let it leak into the home screen).
  const dropDeletedChatFromView = useCallback((chatId: string) => {
    if (currentChatIdRef.current !== chatId && codeChatIdRef.current !== chatId) return;
    setCurrentChatId(null);
    setCodeChatId(null);
    setCodeChatPlain(false);
    setSessionId(null);
    setCodeChrome(null);
    // Review finding M1 (2026-10-27): the files panel kept rendering the
    // deleted chat's canvases — `panelOpen` stayed true and the Flanking
    // header's workspace toggle vanished with the view (showWorkspaceToggle
    // needs codeChatId), leaving the dead chat's docs on screen with no way
    // to close them. Clear the panel trio exactly like startNewChat does.
    setPanelOpen(false);
    setCanvases([]);
    setActiveCanvasId(null);
    // Purge the 15-min transcript snapshot CodeSessionView keeps for this chat
    // (module-level, survives the remount): without this, re-opening the dead
    // id (deep link, dashboard row) re-renders the deleted chat's cached
    // transcript before the first GET 404s.
    purgeSessionSnapshot(chatId);
  }, []);

  // The SSE `chat.deleted` path must not drift from the button path (the
  // cross-tab delete lands through here, not the local button) — one named
  // callback so a future edit to either flow keeps them identical.
  const handleChatDeletedNotice = useCallback((chatId: string) => {
    setChats(prev => prev.filter(c => c.id !== chatId));
    patchRetainedChat(chatId, null); // never first-paint a row deleted in another tab
    dropDeletedChatFromView(chatId);
    refreshFolderLists(); // the folder's count badge must drop with the row
  }, [dropDeletedChatFromView, refreshFolderLists]);

  const { refresh: refreshChatChanges } = usePolling(
    async (signal) => {
      const since = chatsSinceRef.current;
      if (!since) return null;
      // includeArchived (6201e0ee review B1): WITHOUT it, a row another lane
      // just ARCHIVED is filtered out of the response (archived rows leave the
      // default list) — the push-kicked fetch could never see it and the
      // sidebar stayed blind. With it, the just-archived row arrives carrying
      // archivedAt, merges in place, and visibleChats drops it. Always on (not
      // just the notice-kicked tick): the poll is the push's backstop, so it
      // must see archives too; rendering filters by archivedAt either way.
      return crossModelApi.listChatChanges({ since, limit: CHAT_LIST_LIVE_LIMIT, includeArchived: true }, { signal });
    },
    {
      intervalMs: anyCodingSpinner ? CHAT_LIST_LIVE_ACTIVE_MS : CHAT_LIST_LIVE_IDLE_MS,
      enabled: !!user && !isKid,
      immediate: false,
      refreshOnFocus: true,
      onData: (d) => {
        const rawRows = Array.isArray(d?.chats) ? d.chats : [];
        if (rawRows.length === 0) return;
        // A pending ghost flip outranks a row the server built before its PUT.
        const rows = holdGhostRows<CrossModelChat>(rawRows);
        setChats(prev => {
          const m = mergeChatRows(prev, rows);
          return m.changed ? m.rows : prev;
        });
        chatsSinceRef.current = newestUpdatedAt(rows, chatsSinceRef.current);
      },
      // Silent: a failed delta leaves the list as it is; the next tick retries.
      onError: () => {},
    },
  );

  // Server-push invalidation (ticket 6201e0ee): the delta poll above is
  // cadence-bound (15 s active / 60 s idle) and structurally CANNOT see
  // another lane's archive (archived rows leave the default list). This
  // EventSource subscribes to the backend's chat-list event stream and kicks
  // the SAME delta fetch immediately, so a supervisor's archive_chat, a
  // spawned session, or a rename from another tab lands within ~1 s — no
  // manual refresh. The wire is hint-only (kind/chatId/at); rows still come
  // from listChatChanges. Bursts coalesce (listChatChanges throttles).
  useChatListEvents({
    enabled: !!user && !isKid,
    token: accessToken,
    onNotice: (notice) => {
      // Machine-message notification (ticket a4370dd1 → retired by 9d07fd1f,
      // owner 2026-10-19 "minimalistic quiet front end"): an agent-to-agent send
      // that lands in one of this user's chats NO LONGER toasts — the toast was
      // the "received message from session xyz" signal because the unread dot
      // deliberately stays off for machine origins (owner 2026-09-16). The quiet
      // surface is now the CHAT ROW ITSELF: the delta refresh below reconciles
      // it (bumped updatedAt + the "Message from <session>" stub the server
      // sends a minimal viewer), and the message renders in the transcript when
      // the chat is opened. The notice still carries no content — never did.
      if (notice.kind === 'chat.message') {
        // Best-effort row refresh through the existing delta fetch: the
        // STARTED terminal bumps the chat's updatedAt (the row returns), a
        // QUEUED send's row reconciles when the drain starts its run.
        if (chatsSinceRef.current) refreshChatChanges();
        return;
      }
      // A DELETED row never returns in any delta response (review N5) — drop
      // it locally AND clear an open view of it (the owner's "still sits in
      // the chat if you have it open" class, cross-tab flavor: a delete from
      // another tab/device/lane lands here, not through the sidebar button).
      // Every other kind reconciles through the delta fetch.
      if (notice.kind === 'chat.deleted' && notice.chatId) {
        handleChatDeletedNotice(notice.chatId);
        return;
      }
      // Owner 2026-10-27 (stale-rename sweep, review round 2 defect 2): a
      // FOLDER row mutated elsewhere (renamed/archived/restored/deleted) —
      // the chat-row delta feed can never see folder rows, so the sidebar's
      // folder section reconciles ONLY here. One debounced projectsApi.list()
      // (inside refreshFolderLists) serves the burst; no chat-row delta fetch
      // is needed (no chat row changed).
      if (notice.kind === 'project.renamed' || notice.kind === 'project.archived'
        || notice.kind === 'project.restored' || notice.kind === 'project.deleted') {
        refreshFolderLists();
        return;
      }
      // Owner 2026-10-27 (stale-list sweep, finding B): folder composition
      // changed REMOTELY (archived/restored/moved/created elsewhere — another
      // tab, a spawned lane, the hourly auto-archiver). The delta fetch
      // reconciles the chat ROWS but never the folders (counts/names), so a
      // badge could show a chat that left the folder minutes ago. One
      // debounced projectsApi.list() (inside refreshFolderLists) serves the
      // burst; chat.renamed/message stay row-scoped (no folder impact).
      if (notice.kind === 'chat.archived' || notice.kind === 'chat.restored'
        || notice.kind === 'chat.moved' || notice.kind === 'chat.created') {
        refreshFolderLists();
      }
      if (!chatsSinceRef.current) {
        // No watermark yet (first load still in flight) — a full fetch is
        // coming anyway; the notice's row rides it.
        return;
      }
      refreshChatChanges();
    },
  });

  const codingPollFailures = useRef(0);
  usePolling(
    async (signal) => {
      let ids: string[];
      try {
        ids = await codingApi.listRunning({ signal });
      } catch (err) {
        if (isAbortError(err)) return; // superseded tick — never a failure
        // Transient: keep current state and retry. After repeated failures drop
        // the server-driven ids — a spinner stuck on unreachable truth is worse
        // than none (local marks are never pruned on a failed poll).
        if (++codingPollFailures.current >= 3) setCodingRunningIds(prev => (prev.size ? new Set() : prev));
        return;
      }
      if (signal.aborted) return;
      codingPollFailures.current = 0;
      const running = new Set(ids);
      // Sidebar live refresh (ticket d6b2eef5): a running session the sidebar
      // has no row for is a spawn that landed since the last delta — pull the
      // delta now (once per id) instead of waiting for the next tick.
      if (unknownRunningIds(running, new Set(chatsRef.current.map(c => c.id)), liveKickedIds.current).length > 0
          && chatsSinceRef.current) {
        refreshChatChanges();
      }
      setCodingRunningIds(prev =>
        (prev.size === running.size && [...prev].every(id => running.has(id))) ? prev : running);
      const modeById = new Map(chatsRef.current.map(c => [c.id, c.mode]));
      // Ref writes are collected inside the updater but APPLIED after it —
      // StrictMode double-invokes updater functions in dev (review LOW).
      const stampNow: string[] = [];
      const pruned: string[] = [];
      // P2: plain chats in the unified view are marked via handleCodeRunning,
      // but the coding-run truth above never lists them — collect them here
      // (inside the fresh-prev updater; a Set is StrictMode double-invoke
      // safe) and reconcile them against the chat-run liveness endpoint below.
      const plainProbe = new Set<string>();
      setGeneratingChatIds(prev => {
        let changed = false;
        const next = new Set(prev);
        for (const id of prev) {
          // Chats outside the loaded page have unknown mode — skip them: their
          // rows aren't rendered, and the mark reconciles once the chat loads.
          if (modeById.get(id) !== 'code') {
            plainProbe.add(id);
            continue; // legacy-rendered plain chats (kids, backgrounded new-chat streams) also reconcile via their own stream handlers
          }
          if (running.has(id)) continue;             // genuinely still running
          const marked = codingRunMarkedAt.current.get(id);
          if (!marked) { stampNow.push(id); continue; } // start the grace window
          if (Date.now() - marked <= 15_000) continue;
          next.delete(id); pruned.push(id); changed = true;
        }
        return changed ? next : prev;
      });
      const now = Date.now();
      for (const id of stampNow) codingRunMarkedAt.current.set(id, now);
      for (const id of pruned) codingRunMarkedAt.current.delete(id);
      // P2 plain-mark reconcile: a plain run that finishes while its view is
      // unmounted (chat switch mid-run) would otherwise spin the sidebar dot
      // forever — prune against the cross-process liveness truth. A probe
      // ERROR never prunes (transient failures keep the dot and retry next
      // tick); a confirmed-live run re-stamps its grace window.
      if (plainProbe.size) {
        for (const id of plainProbe) {
          if (signal.aborted) return;
          const marked = codingRunMarkedAt.current.get(id);
          if (!marked) { codingRunMarkedAt.current.set(id, Date.now()); continue; } // start the grace window
          if (Date.now() - marked <= 15_000) continue;
          // Tri-state probe (refreshes the 15-min JWT first — review M3):
          // TRUE re-stamps, FALSE prunes, null (error/abort) leaves the dot
          // alone. 'gone' (owner 2026-10-27) = chat deleted/revoked — prune
          // too: the dot would otherwise spin forever on a chat whose
          // === false answer can never come (review round 1, finding 7a).
          const active = await fetchPlainRunActive(id, signal);
          if (signal.aborted) return;
          if (active === true) codingRunMarkedAt.current.set(id, Date.now());
          else if (active === false || active === 'gone') {
            setGeneratingChatIds(prev => { const n = new Set(prev); n.delete(id); return n; });
            codingRunMarkedAt.current.delete(id);
          }
        }
      }
    },
    {
      intervalMs: anyCodingSpinner ? 8_000 : 60_000,
      enabled: !!user,
      pauseWhenHidden: false, // legacy behavior: runs started elsewhere surface even in a background tab
    },
  );

  // Load the fleet hidden-ids once when the user is available — the sidebar
  // hides the fleet chats + the fleet project folder (they live under
  // Management instead). Never breaks the page if the endpoint fails.
  useEffect(() => {
    if (!user) return;
    fleetApi.getSupervisor()
      .then((r) => {
        // Deploy-skew fallback: an old backend has no `hidden` — hide just the supervisor chat.
        const chatIds = new Set(r.hidden?.chatIds ?? (r.supervisor ? [r.supervisor.id] : []));
        const projectIds = new Set(r.hidden?.projectIds ?? []);
        // Mirror at module scope so the NEXT mount's retained seed can filter
        // with a real answer instead of an empty set (review finding, 2026-11-04).
        rememberFleetHidden(chatIds);
        setFleetHidden({ chatIds, projectIds });
      })
      .catch(() => {});
  }, [user]);

  // Retained first paint (ticket b5734922): seed the rail from module scope
  // before the auth probe and the list fetch resolve. Runs ONCE on mount —
  // `railSeeded` is one-shot and never re-arms, exactly like `sidebarHydrated`,
  // so a later refetch can never flash retained rows over live ones.
  useEffect(() => {
    const retained = chatListCache.read('first-page');
    if (!retained || !retained.value.length) return;
    // Filter with the LAST KNOWN fleet-hidden set, not the empty one this mount
    // starts with — an admin must never see fleet chats flash into the rail
    // before the fleet probe lands (review finding, 2026-11-04).
    const visible = retained.value.filter((c) => !retainedFleetHiddenChatIds.has(c.id));
    if (!visible.length) return;
    setChats(visible);
    setRailSeeded(true);
  }, []);

  // First sidebar page of chats — shared by the initial load below and the
  // sidebar error state's Retry button (P4). Resolves null on failure so the
  // deep-link handling in the load effect skips cleanly.
  const fetchChatList = useCallback(async (): Promise<any[] | null> => {
    try {
      const result: any = await crossModelApi.listChats({ page: 1, limit: 30 });
      // (a pending ghost flip outranks a list the server built before its PUT)
      const chatsArr = holdGhostRows<CrossModelChat>(Array.isArray(result?.chats) ? result.chats : Array.isArray(result) ? result : []);
      setChats(chatsArr);
      // Retain for the next return visit (ticket b5734922). Written from the
      // FRESH list only, and it REPLACES the seeded rows above — so a chat
      // deleted/renamed on another device, or a session a framework lane just
      // spawned, reconciles on this same round trip and always wins.
      if (chatsArr.length) chatListCache.write('first-page', chatsArr);
      else chatListCache.purge('first-page');
      // Sidebar live refresh (ticket d6b2eef5): a full list resets the delta
      // watermark to the newest row it carries.
      chatsSinceRef.current = newestUpdatedAt(chatsArr, null);
      setChatsPage(1);
      const pagination = result?.pagination;
      setHasMoreChats(pagination ? pagination.page < pagination.pages : false);
      setChatListError(false);
      return chatsArr;
    } catch {
      setChatListError(true);
      return null;
    }
    // Ticket 26edb492 / 2026-10-20: hydration no longer flips here — the
    // mount loader flips it ONCE after chats + folders + running sessions have
    // ALL settled (success or failure), so the rail paints its final shape
    // instead of chats first, folders next and spinners last. The Retry
    // re-call and archive-restore refetches reach this function too; the flag
    // is one-shot, so they never re-flash skeletons.
  }, [holdGhostRows]);

  // `?q=` prefill (2026-10-16 public-site redesign — lib/chat-prefill.ts): the
  // site's ask bar and suggested prompts link to /?q=<text>. Read it ONCE on
  // mount, strip it from the address bar (other params — chatId, utm_* — stay
  // for their own readers), and drop the text into the home composer WITHOUT
  // sending. The composer can mount after the auth probe settles, so retry
  // briefly until its handle exists; never overwrite a draft already typed.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const text = readPrefill(window.location.search);
    if (!text) return;
    window.history.replaceState(window.history.state, '', withoutPrefill(window.location.pathname, window.location.search, window.location.hash));
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const apply = () => {
      const handle = composerRef.current;
      if (handle) {
        if (!handle.getValue().trim()) {
          setInput(text);
          handle.focus();
        }
        return;
      }
      if (++tries < 60) timer = setTimeout(apply, 100);
    };
    apply();
    return () => { if (timer) clearTimeout(timer); };
  }, [setInput]);

  // Load chats + memory + projects when user is available
  useEffect(() => {
    if (!user) return;

    // Handle URL params from project page deep links (chatId / projectId)
    const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const urlChatId = urlParams?.get('chatId');
    const urlProjectId = urlParams?.get('projectId');

    // Clear URL params without page reload
    if ((urlChatId || urlProjectId) && typeof window !== 'undefined') {
      window.history.replaceState({}, '', window.location.pathname);
    }

    const loaders: Promise<any>[] = [
      // P4: a failed chat-list fetch used to reject the whole Promise.all into
      // the silent tail catch — the sidebar then showed "No chats yet" forever.
      // fetchChatList self-catches (null keeps the deep-link block skipping)
      // and flags the retryable sidebar error state instead.
      fetchChatList(),
      memoryApi.getMemory().then(setMemoryFacts).catch(() => {}),
      // Seed running coding sessions so already-active runs (scheduler, another
      // tab/device) show the sidebar spinner immediately — the reconcile effect
      // above keeps polling while any coding spinner is visible.
      codingApi.listRunning().then(ids => setCodingRunningIds(new Set(ids))).catch(() => {}),
      projectsApi.list().then(({ owned, shared }) => {
        setOwnedProjects(owned);
        setSharedProjects(shared);
        return { owned, shared };
      }).catch(() => {}),
    ];
    // Sidebar hydration (ticket 26edb492; owner 2026-10-20 "that should all
    // happen before loading"): the rail paints ONCE, after the chat list, the
    // folder tree AND the running-session seed have all SETTLED — success or
    // failure (every loader above self-catches; allSettled never rejects), so
    // a dead fetch can never hang the skeletons. Before this the three
    // landed in any order and the rail re-laid itself on each one (chats
    // flat, then folders, then spinners re-pinning rows).
    void Promise.allSettled([loaders[0], loaders[2], loaders[3]]).finally(() => {
      setSidebarHydrated(true);
    });

    // After all loaders, handle deep links
    Promise.all(loaders).then(([chatsArr, , projectsResult]) => {
      if (urlChatId && chatsArr) {
        // Find the chat in our list and load it
        const chatToLoad = chatsArr.find((c: any) => c.id === urlChatId);
        if (chatToLoad) {
          loadChat(chatToLoad);
          // If chat is in a project, expand that project
          if (chatToLoad.projectId) {
            setExpandedProjects(prev => new Set([...prev, chatToLoad.projectId]));
          }
        } else {
          // Chat not in the first sidebar page — fetch a minimal row and open
          // it through loadChat (same pattern as handleOpenSearchResult) so it
          // lands in the right flavor: hasWorkspaceState → coding, otherwise
          // the unified plain flip. (C3 deletion pass, §5b: the old inline
          // stored-message mapping rendered it on the legacy transcript;
          // messageLimit 1 because the row fetch is metadata-only — the view
          // loads the transcript itself.)
          crossModelApi.getChat(urlChatId, { messageLimit: 1 }).then((full: any) => {
            const row = {
              id: full.id,
              title: full.title,
              projectId: full.projectId,
              mode: full.mode,
              codeCapable: (full as any).codeCapable,
              hasWorkspaceState: (full as any).hasWorkspaceState,
              updatedAt: (full as any).updatedAt,
              createdAt: (full as any).createdAt || new Date().toISOString(),
              messages: [],
            } as any;
            setChats(prev => (prev.find(c => c.id === row.id) ? prev : [row, ...prev]));
            loadChat(row);
            if (row.projectId) setExpandedProjects(prev => new Set([...prev, row.projectId as string]));
          }).catch((e: any) => {
            // Owner 2026-10-27 (stale-delete UI report): a deep link to a chat
            // that no longer exists (deleted in another tab, by a lane, or an
            // old bookmark) used to fail SILENTLY — the home composer rendered
            // as if nothing happened, with the dead id still in the URL's
            // wake. Say so instead: honest toast, no row, no mount.
            if (e?.response?.status === 404) {
              toast.error('That chat no longer exists — it may have been deleted.');
            }
          });
        }
      } else if (urlProjectId && projectsResult?.owned) {
        // Set project context for new chat (like startNewChatInProject)
        const proj = projectsResult.owned.find((p: any) => p.id === urlProjectId);
        if (proj) {
          setCurrentProjectId(proj.id);
          setCurrentProjectName(proj.name);
          setExpandedProjects(prev => new Set([...prev, proj.id]));
          toast.info(`Now chatting in "${proj.name}" `);
        }
      }
    }).catch(() => {});
  }, [user]);

  // Per-chat browser tab title (ticket 30833c01): "Digby — <session name>" so a
  // wall of open tabs is tellable apart. Tracks chat switches AND renames (the
  // chats list updates on rename/auto-title); resets to the product title on
  // home and on unmount.
  useEffect(() => {
    const chatTitle = currentChatId ? chats.find(c => c.id === currentChatId)?.title : undefined;
    const home = `${branding.name} — Multi-Model AI`;
    document.title = chatTitle?.trim() ? `${branding.name} — ${chatTitle.trim()}` : home;
    return () => { document.title = home; };
  }, [currentChatId, chats, branding.name]);

  // Load more chats (pagination)
  const loadMoreChats = useCallback(async () => {
    if (loadingMoreChats || !hasMoreChats || !user) return;
    setLoadingMoreChats(true);
    const nextPage = chatsPage + 1;
    try {
      const result: any = await crossModelApi.listChats({ page: nextPage, limit: 30 });
      const moreChats = holdGhostRows<CrossModelChat>(Array.isArray(result?.chats) ? result.chats : []);
      // Dedupe by id — folder-merged chats can overlap with later global pages.
      setChats(prev => {
        const ids = new Set(prev.map(c => c.id));
        const fresh = moreChats.filter((c: any) => !ids.has(c.id));
        return fresh.length ? [...prev, ...fresh] : prev;
      });
      setChatsPage(nextPage);
      const pagination = result?.pagination;
      setHasMoreChats(pagination ? nextPage < pagination.pages : false);
    } catch {
      toast.error('Failed to load more chats');
    } finally {
      setLoadingMoreChats(false);
    }
  }, [loadingMoreChats, hasMoreChats, user, chatsPage, holdGhostRows]);


  // Load a specific chat from the sidebar — C3: every chat opens in the
  // converged CodeSessionView (coding or plain mode); the view owns
  // load/stream/attach for itself. The legacy transcript's plumbing (attach
  // pipes, queued-message clears, scroll-pin arming) is retired.
  const loadChat = useCallback(async (chat: CrossModelChat) => {
    // Skip if already viewing this chat
    if (currentChatIdRef.current === chat.id) return;
    // Attention dots: opening a chat marks it viewed (clears its unread dot).
    writeChatViewed(chat.id);
    // Auto-close sidebar on mobile after selecting a chat
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
    setCurrentChatId(chat.id);
    // Eager ref sync (the state-mirroring effect lands after the next render):
    // the capability fetch below awaits, and its post-await owner check must
    // compare against THIS click even if it resolves before React commits.
    currentChatIdRef.current = chat.id;
    setSessionId(null);
    // Clear canvas state before loading new chat
    setCanvases([]);
    setActiveCanvasId(null);
    setPanelOpen(false);
    // One-Digby C3: workspace chats render INLINE via CodeSessionView — same
    // page, same sidebar; the component owns its own load/stream/approval
    // lifecycle. User Space P3 (spec §4/§5 — THE ROUTING RULE): the SATELLITE
    // decides the flavor — hasWorkspaceState ⇒ coding, anything else ⇒ plain.
    // codeCapable only means "attachable": every auto-filed chat carries it,
    // so keying the view off it would 404 satellite-less chats.
    //
    // P0 2026-09-07 (folder-tree flavor bug): flavor is NEVER decided from a
    // row that LACKS the field — rows merged from the project-detail endpoint
    // carried no capability fields, so `undefined` read as falsy and coding
    // sessions opened as PLAIN chats (patience picker, "Attach a workspace")
    // despite a live satellite. `unknown` now fetches the full chat (getChat
    // returns codeCapable/hasWorkspaceState) BEFORE choosing; a failed fetch
    // falls back to plain with a warn — except the legacy mode='code' marker,
    // which forces coding (lib/chat-flavor.ts).
    let flavor = chatFlavorFromRow(chat);
    if (flavor === 'unknown') {
      try {
        const full: any = await crossModelApi.getChat(chat.id, { messageLimit: 1 });
        flavor = full?.hasWorkspaceState ? 'coding' : 'plain';
        // Patch the row so the next open (and the attach triggers) skip the fetch.
        setChats(prev => prev.map(c => c.id === chat.id
          ? { ...c, hasWorkspaceState: !!full?.hasWorkspaceState, codeCapable: (full?.codeCapable ?? (c as any).codeCapable) as boolean | undefined }
          : c));
      } catch {
        flavor = chatFlavorFetchFallback(chat);
        console.warn(`[loadChat] capability fetch failed for ${chat.id} — falling back to ${flavor}`);
      }
      // A different chat was clicked while the capability fetch was in flight —
      // its own loadChat owns the view now; mounting here would clobber it.
      if (currentChatIdRef.current !== chat.id) return;
    }
    if (flavor === 'coding') {
      setCodeInitialMessage(null); // never auto-send a stale composer message into an existing session
      setCodeInitialImages([]);
      setCodeInitialDisplay(null);
      setCodeChatPlain(false);
      setCodeChatId(chat.id);
      return;
    }
    // Plain chats open in the same converged view (plain mode). C3 blocker 3:
    // KIDS flip too — the D5 rails are honored in the unified view
    // (no depth control renders for anyone since roster 2026-10-06 B-3; the
    // sponsored ThinkingAd slot is GONE — todo 9a3e82af; Report-issue is adult-only in PlainMessageActions; Schedules is
    // withheld by the section registry; kid status lines forward via the
    // plain-session normalizer; the kid web-search cue renders from the same
    // metadata). The view owns load/stream, exactly like the satellite branch
    // above — the page only stages the mount.
    setCodeInitialMessage(null);
    setCodeInitialImages([]);
    setCodeInitialDisplay(null);
    setCodeChatPlain(true);
    setCodeChatId(chat.id);
    // Persisted canvases (flip blocker M5): the unified view owns the
    // transcript but the canvas panel is page chrome — load them here.
    canvasApi.listForChat(chat.id).then((chatCanvases: any[]) => {
      if (currentChatIdRef.current !== chat.id || chatCanvases.length === 0) return;
      const items: CanvasItem[] = chatCanvases.map((c: any) => ({
        id: c.id,
        title: c.title,
        type: c.type as CanvasItem['type'],
        language: c.language ?? null,
        content: c.content || '',
        version: c.version,
        updatedAt: c.updatedAt,
        createdAt: c.createdAt,
      }));
      setCanvases(items);
      // File browser (59a4454e): land on the file list, not inside the first doc.
      setActiveCanvasId(null);
      setPanelOpen(true);
    }).catch(() => { /* canvases are best-effort */ });
    // Depth UX (2026-09-26; roster 2026-10-06 B-3): a chat's stored level is never restored into the page —
    // there is no depth control to restore INTO; every signed-in send is Auto (Digby picks per message).
  }, []);

  // Deep search (ticket 4fd1de3c): open the chat behind a search result. Prefer
  // the already-loaded sidebar row (it carries mode/projectId/hasWorkspaceState);
  // otherwise fetch a minimal row so loadChat opens it in the right flavor
  // (the coding flavor needs the satellite flag — hasWorkspaceState).
  const handleOpenSearchResult = useCallback(async (chatId: string) => {
    setDeepSearchOpen(false);
    const existing = chats.find((c) => c.id === chatId);
    if (existing) {
      loadChat(existing);
      if (existing.projectId) setExpandedProjects(prev => new Set([...prev, existing.projectId as string]));
      return;
    }
    try {
      // Initial-load cap (the C3-retired INITIAL_MESSAGE_PAGE const): deep
      // search opens a minimal row — the view loads the transcript itself.
      const full = await crossModelApi.getChat(chatId, { messageLimit: 50 });
      const row = {
        id: full.id,
        title: full.title,
        projectId: full.projectId,
        mode: full.mode,
        codeCapable: (full as any).codeCapable,
        hasWorkspaceState: (full as any).hasWorkspaceState,
        updatedAt: (full as any).updatedAt,
        createdAt: (full as any).createdAt || new Date().toISOString(),
        messages: [],
      } as any;
      setChats(prev => prev.find(c => c.id === row.id) ? prev : [row, ...prev]);
      loadChat(row);
      if (row.projectId) setExpandedProjects(prev => new Set([...prev, row.projectId as string]));
    } catch {
      toast.error('Failed to open chat');
    }
  }, [chats, loadChat]);

  // ⌘K / Ctrl+K opens deep search (standard command-palette shortcut). Kids get
  // a stripped UI, so the shortcut is adults-only, same as the sidebar button.
  useEffect(() => {
    if (!user || isKid) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setDeepSearchOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [user, isKid]);

  // Sidebar pending-confirmations banner click: open the chat that's blocked on
  // a human. Workspace chats open inline via loadChat's hasWorkspaceState branch
  // (CodeSessionView renders its own question/approval cards there). A chat
  // outside the sidebar's loaded page is fetched by id first (deep-link
  // precedent) so the banner works for older chats too.
  const handleOpenPendingConfirmation = useCallback((p: PendingConfirmation) => {
    const existing = chats.find(c => c.id === p.chatId);
    if (existing) { void loadChat(existing); return; }
    // messageLimit 1 (owner 2026-10-20: "click open chat or ANY linked
    // session … takes forever, almost a minute"): without a limit this was
    // the LEGACY full-transcript path — every stored row of a long-running
    // chat (a supervisor / feed chat carries thousands) fetched just to learn
    // the row's flavor. The view loads the transcript itself, paged.
    crossModelApi.getChat(p.chatId, { messageLimit: 1 }).then((full: any) => {
      const row = {
        id: full.id, title: full.title, projectId: full.projectId, mode: full.mode,
        codeCapable: full.codeCapable, hasWorkspaceState: full.hasWorkspaceState, messages: [],
        createdAt: full.createdAt || new Date().toISOString(),
        updatedAt: full.updatedAt || new Date().toISOString(),
      } as CrossModelChat;
      setChats(prev => (prev.find(c => c.id === p.chatId) ? prev : [row, ...prev]));
      void loadChat(row);
    }).catch(() => toast.error('Could not open that chat'));
  }, [chats, loadChat]);
  // Inline task card (cohesive chat, 2026-09-28): a card's "Open session"
  // opens the spawned sub-session by id — the same open-by-id path the
  // pending-action rail uses (loads an unlisted chat on demand).
  const openChatById = useCallback((id: string) => {
    handleOpenPendingConfirmation({ chatId: id } as PendingConfirmation);
  }, [handleOpenPendingConfirmation]);

  // Start a brand new chat
  const startNewChat = useCallback(() => {
    setCurrentChatId(null);
    setCurrentProjectId(null);
    setCurrentProjectName(null);
    setCodeChatId(null);
    setCodeChatPlain(false);
    setChatless(null);
    setSessionId(null);
    // Clear canvas panel when starting a new chat
    setCanvases([]);
    setActiveCanvasId(null);
    setPanelOpen(false);
    // Auto-close sidebar on mobile
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  }, []);

  // ── Guest sessions (feedback ticket 63bb607f) ─────────────────────────────
  // Hydrate the browser-local list post-mount (localStorage is client-only —
  // reading it during SSR/initial render would fork the hydration tree).
  useEffect(() => { setGuestSessions(loadGuestSessions()); }, []);

  // Ghost mode (2026-10-22): hydrate the OPEN session's flag post-mount
  // (localStorage is client-only — same SSR-safety as the list above) and on
  // every guest-session switch, so a reopened ghost conversation stays ghost.
  // chatlessActive (not raw chatless): a signed-in chat mounting must reset
  // the mirror — the flag belongs to the GUEST view only.
  useEffect(() => {
    setGuestGhostState(chatlessActive?.guest ? getGuestGhost(activeGuestId) : false);
  }, [chatlessActive?.guest, activeGuestId]);

  /** Toggle the OPEN guest conversation's ghost mode (persists per-session in
   *  localStorage; drives the ghost=true send param + the header indicator). */
  const toggleGuestGhost = useCallback(() => {
    const sid = activeGuestId;
    if (!sid) return;
    const next = !getGuestGhost(sid);
    setGuestGhost(sid, next);
    setGuestGhostState(next);
  }, [activeGuestId]);

  // ── Ghost composer toggle (2026-10-22, SIGNED-IN; lib/ghost-composer.ts) ──
  // Owner ask 2026-10-22 ("where is the ghost model icon for users to test in
  // the ui?"). integ/ghost-composer merged PR #1897 (the open-chat toggle) and
  // feat/ghost-composer-toggle (the home arm, the race-free panel switch) into
  // ONE toggle on ONE seam. The open chat's row decides: home ⇒ arm the next
  // new chat; the owner's own PLAIN chat with a KNOWN posture ⇒ flip it;
  // anything else ⇒ no toggle (coding sessions, supervisor chats / lanes,
  // kids, other people's chats, NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED=1).
  const ghostRow = codeChatId ? chats.find(c => c.id === codeChatId) : undefined;
  const ghostInput: GhostToggleInput = {
    viewerId: user?.id ?? null,
    isKid,
    chatId: codeChatId,
    chatless: !!chatlessActive,
    plain: codeChatPlain,
    row: ghostRow,
  };
  // The ONE signed-in ghost-affordance rule (#1897's signedInGhostChatId, now
  // lib/ghost-composer.ts ghostEligibleChatId) — the user's own PLAIN chat
  // only: kids, coding sessions (codeChatPlain false), supervisor lanes and
  // other people's chats in shared folders never offer it. The side-panel
  // Settings switch reads it directly (ghostChatId); the composer toggle reads
  // it through ghostToggleTarget, which also needs a KNOWN posture.
  const signedInGhostChatId = ghostEligibleChatId(ghostInput);
  const ghostTarget = ghostToggleTarget(ghostInput);

  // A MINIMAL row (open-by-id / search / URL paths build one without the
  // posture or the owner facts) gets them read — the toggle stays hidden
  // until they land, never guessing "off" for a chat that is in ghost mode.
  // The same patch lights the header badge for such a chat.
  // integ/ghost-composer review fix: NO row at all reads them too — an older
  // chat opened by search / URL loses its minimal row to a full list refresh
  // (sidebar Retry, archive-restore), and the toggle used to vanish for good
  // (no row ⇒ posture unknown ⇒ no toggle; nothing read again). The read puts
  // the row back while the chat is still open (withGhostFacts). The id leaves
  // the in-flight set when the read settles, so a failed read, or a row dropped
  // again later, is read again on the next change instead of never.
  const ghostFactsReadRef = useRef<Set<string>>(new Set());
  const ghostRowNeedsFacts = !ghostRow || typeof ghostRow.ghostMode !== 'boolean';
  useEffect(() => {
    if (!user || isKid || !codeChatId || !codeChatPlain || ghostComposerToggleDisabled()) return;
    if (!ghostRowNeedsFacts || ghostFactsReadRef.current.has(codeChatId)) return;
    ghostFactsReadRef.current.add(codeChatId);
    const id = codeChatId;
    crossModelApi.getChat(id, { messageLimit: 1 })
      .then((full: unknown) => {
        // A read that raced a flip of this chat carries the old posture — hold it like any stale row.
        const read = full && typeof full === 'object' && (full as { id?: unknown }).id === id
          ? holdGhostRows([full as { id: string; ghostMode?: boolean; updatedAt?: unknown }])[0]
          : full;
        setChats(prev => withGhostFacts(prev, id, read, codeChatIdRef.current === id));
      })
      .catch(() => { /* the side panel's switch still self-loads — the composer toggle stays hidden until a later read */ })
      .finally(() => { ghostFactsReadRef.current.delete(id); });
  }, [user, isKid, codeChatId, codeChatPlain, ghostRowNeedsFacts, holdGhostRows]);

  /** Flip the OPEN chat's ghost mode — the side panel's GhostModeRow save
   *  (updateChat { ghostMode }), then patch the sidebar row so the header
   *  badge, this toggle and the panel switch all flip together. The row IS the
   *  one source of truth (integ/ghost-composer dropped #1897's separate
   *  ghostToggles mirror: a side-panel flip patched the row but not the mirror,
   *  so the mirror then out-voted the row — the composer button and the badge
   *  kept showing the OLD posture). A minimal row gets its posture read once
   *  above, so no mirror is needed to cover it. */
  const toggleChatGhost = useCallback(async (chatId: string, current: boolean) => {
    if (chatGhostSavingRef.current) return;
    chatGhostSavingRef.current = true;
    setChatGhostSaving(true);
    try {
      let saved: unknown;
      const next = await flipChatGhost(crossModelApi.updateChat, chatId, current, (row) => { saved = row; });
      // Held against a stale list row until the server's rows agree (the PUT's own updatedAt orders them).
      noteGhostFlip(chatId, next, saved);
      setChats(prev => prev.map(c => c.id === chatId ? { ...c, ghostMode: next } : c));
      toast.success(next ? 'Ghost mode on for this chat' : 'Ghost mode off');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || err?.message || 'Could not change ghost mode');
    } finally {
      chatGhostSavingRef.current = false;
      setChatGhostSaving(false);
    }
  }, [noteGhostFlip]);

  // Rail "New chat": name the conversation up front and mount a fresh guest
  // view (startNewChat clears any lingering mount + auto-closes the mobile
  // rail; the guest view's empty state IS the polished centered composer).
  const startNewGuestChat = useCallback(() => {
    startNewChat();
    setActiveGuestId(crypto.randomUUID());
    setChatless({ guest: true, nonce: Date.now() });
  }, [startNewChat]);

  // ⌘⇧O / Ctrl+Shift+O starts a new chat (Digby Frontier rail hint — the
  // same shortcut frontier assistants use). Signed-out visitors get a fresh
  // guest conversation, the guest rail's "New chat".
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        if (user) startNewChat(); else startNewGuestChat();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [user, startNewChat, startNewGuestChat]);

  // Rail row select: point activeGuestId at the record and remount the
  // chatless guest view (new nonce) — it seeds from the record's browser-local
  // transcript via plain.initialTranscript.
  const selectGuestSession = useCallback((id: string) => {
    setActiveGuestId(id);
    setChatless({ guest: true, nonce: Date.now() });
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  }, []);

  // Rail row delete: remove from the store; deleting the OPEN conversation
  // also returns home (an unowned live view would silently re-persist on its
  // next turn via onTranscriptChange).
  const deleteGuestSession = useCallback((id: string) => {
    removeGuestSession(id);
    clearGuestGhost(id); // ghost flag dies with its session
    setGuestSessions(loadGuestSessions());
    if (id === activeGuestId) {
      setActiveGuestId(null);
      setChatless(null);
    }
  }, [activeGuestId]);

  // The mounted guest view's transcript mirror: upsert into the store (title
  // minted once from the first user message; updatedAt now) and refresh the
  // rail list from the store (it stays the sorted/capped source of truth).
  const handleGuestTranscript = useCallback((gid: string, messages: CodingMessage[]) => {
    const now = new Date().toISOString();
    const existing = getGuestSession(gid);
    const firstUser = messages.find(m => m.role === 'user');
    upsertGuestSession({
      id: gid,
      title: existing?.title ?? guestSessionTitle(firstUser?.content ?? ''),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      messages,
    });
    setGuestSessions(loadGuestSessions());
  }, []);

  // The mounted guest view's SERVER title (2026-09-26 — "guest mode, chat
  // title generation didn't work"): the 'chat-title' frame / the autoTitle
  // echo on complete retitle the browser-local record when it still holds
  // the first-message placeholder, then refresh the rail from the store.
  const handleGuestTitle = useCallback((gid: string, title: string) => {
    if (retitleGuestSession(gid, title)) setGuestSessions(loadGuestSessions());
  }, []);

  // Start a new chat from a news headline follow-up button.
  // Stores the prompt in a ref, calls startNewChat(), and the useEffect
  // (after handleSendMessage) fires the prompt once messages are cleared.
  const handleNewsExpand = useCallback((index: number) => {
    setExpandedNewsIndices(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
        // Mark as read when first expanded
        setReadNewsIndices(rp => {
          if (rp.has(index)) return rp;
          const rn = new Set(rp);
          rn.add(index);
          return rn;
        });
      }
      return next;
    });
    // Scroll the expanded card into view after React re-renders
    requestAnimationFrame(() => {
      const el = newsCardRefs.current.get(index);
      if (el) {
        // Use 'start' so the full expanded card is visible from the top
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        // On mobile, nudge up a bit so the card header isn't hidden behind sticky elements
        setTimeout(() => {
          const rect = el.getBoundingClientRect();
          if (rect.top < 8) window.scrollBy({ top: rect.top - 16, behavior: 'smooth' });
        }, 250);
      }
    });
  }, []);

  // Escape key collapses all expanded news cards
  useEffect(() => {
    const handleEscapeNews = (e: KeyboardEvent) => {
      // Home condition (C3): no converged view mounted (coded or chatless).
      if (e.key === 'Escape' && expandedNewsIndices.size > 0 && !codeChatId && !chatlessActive) {
        setExpandedNewsIndices(new Set());
      }
    };
    window.addEventListener('keydown', handleEscapeNews);
    return () => window.removeEventListener('keydown', handleEscapeNews);
  }, [expandedNewsIndices.size, codeChatId, chatlessActive]);

  const handleNewsFollowUp = useCallback((prompt: string, displayText?: string) => {
    setExpandedNewsIndices(new Set());
    pendingNewsPromptRef.current = prompt;
    pendingNewsDisplayRef.current = displayText || null;
    startNewChat();
    // Bump trigger so the pending-news useEffect re-fires even when
    // messages.length was already 0 (user on home screen, no active chat)
    setNewsTrigger(n => n + 1);
  }, [startNewChat]);

  // Delete a chat (called after confirmation)
  const deleteChat = useCallback(async (chatId: string) => {
    setDeletingChatId(null);
    try {
      await crossModelApi.deleteChat(chatId);
      setChats(prev => prev.filter(c => c.id !== chatId));
      patchRetainedChat(chatId, null); // never first-paint a deleted row on the next return
      dropDeletedChatFromView(chatId);
      refreshFolderLists(); // the folder's count badge must drop with the row
      toast.success('Chat deleted');
    } catch {
      toast.error('Failed to delete chat');
    }
  }, [dropDeletedChatFromView, refreshFolderLists]);

  // Archive a chat — the primary de-clutter path (delete stays the permanent
  // one). No confirmation: archive is lossless, and the toast offers Undo.
  // The archivedAt patch drops the row out of visibleChats instantly; the
  // Archived section below the sidebar lists owns browse + restore.
  const archiveChat = useCallback(async (chatId: string) => {
    try {
      await crossModelApi.archiveChat(chatId);
      const archivedAt = new Date().toISOString();
      setChats(prev => prev.map(c => c.id === chatId ? { ...c, archivedAt } : c));
      // PATCH, not drop (review finding 1, 2026-11-04): archiving does not
      // remove the row — it sets `archivedAt`, and `visibleChats` hides it. The
      // retained copy still carried the PRE-archive shape, so the archived chat
      // first-painted back into the CHATS rail for a whole round trip. The
      // patch makes the retained row carry the hidden shape instead.
      patchRetainedChat(chatId, { archivedAt });
      setArchiveVersion(v => v + 1); // an open Archived section refetches
      // An open view of the archived chat leaves with the row (the owner's
      // "still sits in the chat if you have it open" class — archive flavor).
      dropDeletedChatFromView(chatId);
      refreshFolderLists(); // the folder's count badge must drop with the row
      toast.success('Chat archived', {
        action: {
          label: 'Undo',
          onClick: () => {
            void crossModelApi.restoreChat(chatId)
              .then(() => {
                setChats(prev => prev.map(c => c.id === chatId ? { ...c, archivedAt: null } : c));
                setArchiveVersion(v => v + 1);
                refreshFolderLists(); // the Undo restores the badge too
              })
              .catch(() => toast.error('Failed to restore chat'));
          },
        },
      });
    } catch (err: unknown) {
      // 409s carry the honest reason (run active / schedules enabled) — surface it.
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || 'Failed to archive chat');
    }
  }, [dropDeletedChatFromView, refreshFolderLists]);


  // ── Attach a workspace (User Space P3, spec §6.3) — the ONE power gesture ──
  // The ⋯-menu item on an OPEN plain chat attaches the ChatCodingState
  // satellite to THAT chat — same row, same id, full history (the coding
  // transcript reads the same message store). No destination pick: every chat
  // is already filed (auto-filing), so the bare endpoint call is the whole
  // gesture. Success patches the sidebar row and flips codeChatPlain — the
  // `${chatId}:${flavor}` mount key remounts the view in the coding flavor.
  const attachWorkspace = useCallback(async () => {
    if (!codeChatId || !codeChatPlain) return;
    const chatId = codeChatId;
    try {
      await crossModelApi.convertToCoding(chatId);
      setChats(prev => prev.map(c => c.id === chatId
        ? { ...c, hasWorkspaceState: true, codeCapable: true }
        : c));
      setCodeChatPlain(false);
      toast.success('Workspace attached — this chat now runs in its workspace');
    } catch (err: any) {
      // Honest failure: surface the server's own message (e.g. the 400 when
      // the chat's folder chain resolves no workspace).
      toast.error(err?.response?.data?.error || 'Could not attach a workspace');
    }
  }, [codeChatId, codeChatPlain]);

  const handleSendMessageInner = useCallback(
    async (e: React.FormEvent | null, overrideMessage?: string, overrideDisplayContent?: string) => {
      if (e) e.preventDefault();
      const messageText = (overrideMessage ?? composerRef.current?.getValue() ?? '').trim();
      // Attachment state snapshot (the staged chips ride the view's
      // plain.takeAttachments at hand-off — they are NOT consumed here).
      const hasAttachments = attachments.length > 0;
      if (!messageText && !hasAttachments) return;

      // ── Pre-send length gate (ticket 4b7a32b1) ──────────────────────────────
      // Refuse an over-cap message HERE, with the length named, instead of the
      // silent 1,500-char truncation fallback / opaque register rejection down
      // the send path. The draft + attachments stay put so the user can trim.
      // Only the typed text is capped (attachment-only sends use a short
      // placeholder). Applies whether or not a run is in flight, so it also
      // gates the queued-send branch below.
      if (messageText.length > MAX_CHAT_MESSAGE_CHARS) {
        toast.error(
          `Message is ${messageText.length.toLocaleString()} characters — chat accepts at most ${MAX_CHAT_MESSAGE_CHARS.toLocaleString()}. Trim it or split it into parts.`,
        );
        return;
      }

      // ── P4: coding left the slider — sends here ALWAYS run the chat pipeline.
      // Owner 2026-09-26 ("default all chats to auto"): the new chat is created
      // with NO mode — the server stores its default ('auto'); the depth of
      // each send still rides the send itself (depthPrefToWire below: the
      // Advanced "Default depth" preset or Auto), never the chat row.

    // When sending attachment(s) with no text, use a descriptive placeholder so the
    // backend pipeline has a message to work with (e.g. "Analyze this image").
    const effectiveMessage = messageText || (
      attachments.some(a => a.type === 'image')
        ? 'Describe and analyze the attached image(s).'
        : attachments.some(a => a.type === 'audio')
          ? 'Analyze the attached audio clip(s).'
          : 'Analyze the attached file(s).'
    );
    // First-party visitor analytics (owner 2026-10-07): the home composer's send — the client copy of chat_sent
    // (the server records every send authoritatively; kids never — gated in lib/visitor-analytics.ts).
    trackVisitEvent('chat_sent', { surface: user ? 'home' : 'guest' });

    // ── C3 (ticket 71b1fec6): every home-composer send hands off to the
    // converged CodeSessionView — the legacy in-page transcript and its stream
    // machinery are RETIRED. A SIGNED-IN user gets create-then-hand-off (one
    // inline retry on createChat failure, then the chatId-less FALLBACK
    // mount); an ANONYMOUS guest mounts the limited chatId-less GUEST mode
    // (owner directive: "very limited features and push cta to sign up for
    // that access"). Chatless mounts consume this message via the view's
    // plain auto-start — the same initialMessage mechanism as the coded
    // hand-off.
    if (user) {
      let newChatId: string | null = null;
      for (let attempt = 0; attempt < 2 && !newChatId; attempt++) {
        try {
          // Placeholder title — same shape as any hand-off (MUST mirror
          // backend title-placeholder.ts, ticket 26385762).
          const title = effectiveMessage.slice(0, 60) + (effectiveMessage.length > 60 ? '…' : '');
          // Ghost composer toggle (2026-10-22): an ARMED home toggle creates
          // the chat in ghost mode (ghostMode:true on POST /chats), so the
          // FIRST send already runs private; unarmed, the body is unchanged.
          const chatData = await createChatWithGhost(crossModelApi.createChat, { title, projectId: currentProjectIdRef.current || undefined }, newChatGhostRef.current);
          newChatId = chatData.data.id;
          setChats(prev => [chatData.data, ...prev]);
          // Retain it too (review finding 1): otherwise the next return visit
          // first-paints a rail missing the chat just created, and with
          // `railReady` true there is no skeleton to explain the gap.
          retainApiChatRow(chatData.data);
          // The arm is consumed: the chat row now carries the posture (the open
          // chat's toggle + header badge read it); home starts unarmed again.
          setNewChatGhost(false);
          // Point currentChatId at the new chat (same as startNewChatInProject):
          // the sidebar highlight moves, and a self-click short-circuits at
          // loadChat's already-current guard — otherwise that click would
          // clear codeInitialMessage before the view's auto-start fires.
          setCurrentChatId(newChatId);
          currentChatIdRef.current = newChatId;
          setCodeChatPlain(true);
          setCodeChatId(newChatId);
        } catch {
          // createChat failed (offline/5xx) — retry once; a second failure
          // falls through to the chatId-less FALLBACK below.
        }
      }
      if (newChatId) {
        setInput('');
        setCharCount(0);
        discardRecording();
        // '' is a real hand-off (attachment-only send): the view's plain
        // auto-start treats null/undefined as "nothing pending" but fires on
        // '', letting send() build the server placeholder while the bubble
        // shows just the chips (legacy displayContent semantics).
        setCodeInitialMessage(messageText);
        setCodeInitialDisplay(overrideDisplayContent ?? null);
        setCodeInitialImages([]); // plain sends carry files via takeAttachments, not ChatImage[]
        return;
      }
      // ── C3 FALLBACK: createChat failed twice — mount the converged view
      // chatId-less. The send rides the open /crossmodel/stream endpoint
      // (server-side cm_session context): full composer features, but the
      // conversation is ephemeral (unsaved) with no re-attach — the user
      // still gets their answer. An ARMED ghost toggle rides the chatless
      // mount (ghost=true on every send of it — no row exists to carry it).
      setChatless({ guest: false, nonce: Date.now(), ...(newChatGhostRef.current ? { ghost: true } : {}) });
      setNewChatGhost(false);
    } else {
      // ── C3 GUEST: anonymous send — the limited chatId-less guest mode.
      // 63bb607f: name the conversation up front — the rail row, the
      // browser-local record, and the server-side cm_session context key all
      // ride this one client-minted UUID.
      setActiveGuestId(crypto.randomUUID());
      setChatless({ guest: true, nonce: Date.now() });
    }
    // Chatless hand-off (fallback + guest): staged attachments ride
    // plain.takeAttachments on the view's auto-start send (ticket 625773b5:
    // guests stage uploads too — the hand-off is identical for both mounts).
    setInput('');
    setCharCount(0);
    discardRecording();
    setCodeInitialMessage(messageText);
    setCodeInitialDisplay(overrideDisplayContent ?? null);
    setCodeInitialImages([]);
  },
  [user, mode, attachments, discardRecording, setNewChatGhost]
);
  // Safety-net wrapper: ANY rejection in the send pipeline (createChat race,
  // EventSource constructor, a thrown regression) must surface and reset —
  // never leave the user's message sitting with a spinner and no answer.
  const handleSendMessage = useCallback(
    async (e: React.FormEvent | null, overrideMessage?: string, overrideDisplayContent?: string) => {
      try {
        await handleSendMessageInner(e, overrideMessage, overrideDisplayContent);
      } catch (sendErr: any) {
        // C3: no legacy stream state to reset — the converged view owns its
        // own stream lifecycle; a rejection here just surfaces.
        console.error('[Digby] Send pipeline failed:', sendErr);
        toast.error('Failed to send your message — please try again.');
      }
    },
    [handleSendMessageInner],
  );

  // Fire pending news prompt after startNewChat() clears messages.
  // newsTrigger ensures this also fires when messages were already empty
  // (user on home screen with no active chat — messages.length stays 0).
  useEffect(() => {
    // Home is guaranteed: any send mounts the converged view (C3), so a
    // pending news prompt can only fire while no chat is open.
    if (pendingNewsPromptRef.current) {
      const prompt = pendingNewsPromptRef.current;
      const displayText = pendingNewsDisplayRef.current;
      pendingNewsPromptRef.current = null;
      pendingNewsDisplayRef.current = null;
      // Use requestAnimationFrame to ensure React has flushed the state reset
      requestAnimationFrame(() => {
        handleSendMessage(null, prompt, displayText || undefined);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleSendMessage, newsTrigger]);



  // (C3 deletion pass, §5b: the idle-chat liveness watch — runs started
  // elsewhere surfacing into an open LEGACY chat — is gone. Every stored chat
  // opens in the unified view, which owns attach/reconcile for itself.)

  // ── Memory dialog handlers ────────────────────────────────────────────────
  const [newFactKey, setNewFactKey] = useState('');
  const [newFactValue, setNewFactValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  const handleSaveFact = async () => {
    if (!newFactKey.trim() || !newFactValue.trim()) return;
    try {
      await memoryApi.updateFact(newFactKey.trim(), newFactValue.trim());
      setMemoryFacts(prev => ({ ...prev, [newFactKey.trim()]: newFactValue.trim() }));
      setNewFactKey('');
      setNewFactValue('');
      toast.success('Memory fact saved');
    } catch { toast.error('Failed to save fact'); }
  };

  const handleUpdateFact = async (key: string) => {
    if (!editingValue.trim()) return;
    try {
      await memoryApi.updateFact(key, editingValue.trim());
      setMemoryFacts(prev => ({ ...prev, [key]: editingValue.trim() }));
      setEditingKey(null);
      toast.success('Fact updated');
    } catch { toast.error('Failed to update fact'); }
  };

  const handleDeleteFact = async (key: string) => {
    try {
      await memoryApi.deleteFact(key);
      setMemoryFacts(prev => { const n = { ...prev }; delete n[key]; return n; });
      toast.success(`"${key}" deleted`);
    } catch { toast.error('Failed to delete fact'); }
  };

  const handleClearMemory = async () => {
    try {
      await memoryApi.clearMemory();
      setMemoryFacts({});
      toast.success('All memory cleared');
    } catch { toast.error('Failed to clear memory'); }
  };

  // (C3 deletion pass, §5b: the per-message feedback handler and the frontier
  // fact-check stream are gone from this page — both required a saved chat
  // (authed), and signed-in chats no longer render on the legacy transcript.
  // The unified view's PlainMessageActions owns Report-issue.)


  // ── File upload handler — supports multiple files ─────────────────────────
  // Staging logic lives in ./components/attachments (uploadChatFiles) — shared
  // with the Management supervisor composer. onBytesReady flips the spinner
  // ONLY after every byte is in memory (a mid-read disable would revoke File
  // permission in Chrome — see the module header).
  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    let newItems: AttachmentInfo[] = [];
    try {
      newItems = await uploadChatFiles(fileList, {
        projectId: currentProjectIdRef.current,
        onBytesReady: () => setUploading(true),
        // Ticket 33a742c1: keep every failed file visible inline instead of
        // letting it disappear behind a transient toast.
        onRejected: (rejections) => setAttachmentRejections(prev => [...prev, ...rejections]),
      });
    } finally {
      setUploading(false);
    }
    if (newItems.length) setAttachments(prev => [...prev, ...newItems]);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      const input = e.target; // Capture ref before async work
      // Clear AFTER processFiles reads the files — clearing input.value
      // before arrayBuffer() completes invalidates File references in Chrome
      processFiles(e.target.files).finally(() => {
        try { input.value = ''; } catch { /* ignore */ }
      });
    }
  }, [processFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files);
  }, [processFiles]);

  // ── Clipboard paste handler — captures images pasted via Ctrl+V ──────────
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items);
    const imageItems = items.filter(item => item.type.startsWith('image/'));
    if (imageItems.length > 0) {
      e.preventDefault();
      const files = imageItems.map(item => item.getAsFile()).filter((f): f is File => f !== null);
      if (files.length > 0) processFiles(files);
    }
  }, [processFiles]);

  // Stable props for <ChatComposerTextarea> (so its memo holds when the page re-renders for other
  // reasons). onEmptyChange fires only on empty↔non-empty transitions, toggling the Send button.
  const submitFromComposer = useCallback(() => { void handleSendMessage(null); }, [handleSendMessage]);
  const handleComposerEmptyChange = useCallback((isEmpty: boolean) => {
    setHasText(!isEmpty);
    // The first keystroke (or a starter tap) warms the transcript view's chunk
    // so the send that follows never waits on it (import() is cached).
    if (!isEmpty) void loadCodeSessionView();
  }, []);
  // Signed-in users nearly always open a chat next — warm the view once idle.
  useEffect(() => {
    if (!user) return;
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    const run = () => { void loadCodeSessionView(); };
    if (w.requestIdleCallback) w.requestIdleCallback(run); else setTimeout(run, 2000);
  }, [user]);

  // ── Chat rename handlers ──────────────────────────────────────────────────
  const handleRenameStart = useCallback((chat: CrossModelChat, e: React.MouseEvent) => {
    e.stopPropagation();
    setRenamingChatId(chat.id);
    setRenameValue(chat.title);
  }, []);

  const handleRenameSubmit = useCallback(async (chatId: string) => {
    const trimmed = renameValue.trim();
    setRenamingChatId(null);
    if (!trimmed) return;
    try {
      await crossModelApi.updateChat(chatId, { title: trimmed });
      setChats(prev => prev.map(c => c.id === chatId ? { ...c, title: trimmed } : c));
      // Same reason as archive (review finding 1): the retained row must not
      // first-paint the OLD title on the next return visit.
      patchRetainedChat(chatId, { title: trimmed });
    } catch {
      toast.error('Failed to rename chat');
    }
  }, [renameValue]);

  const factEntries = Object.entries(memoryFacts);

  // ── Project handlers ──────────────────────────────────────────────────────
  const handleCreateProject = useCallback(async () => {
    if (!newProjectName.trim()) return;
    setCreatingProject(true);
    try {
      const parentId = newProjectParentId || null;
      const project = await projectsApi.create({
        name: newProjectName.trim(),
        emoji: newProjectEmoji,
        color: 'violet',
        parentId,
      });
      setOwnedProjects(prev => [
        { ...project, chatCount: project.chatCount ?? 0, documentCount: project.documentCount ?? 0, parentId: project.parentId ?? parentId },
        ...prev,
      ]);
      // Expand the parent chain so the new folder is visible in the tree.
      if (parentId) {
        const ancestorIds = getFolderPath(parentId).map(p => p.id);
        setExpandedProjects(prev => new Set([...prev, ...ancestorIds]));
      }
      setShowNewProjectDialog(false);
      setNewProjectName('');
      setNewProjectEmoji('📁');
      setNewProjectParentId('');
      toast.success(`Folder "${project.name}" created`);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Failed to create folder');
    } finally {
      setCreatingProject(false);
    }
  }, [newProjectName, newProjectEmoji, newProjectParentId, getFolderPath]);

  const toggleProject = useCallback((projectId: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  // When a project is expanded (via the sidebar toggle OR any auto-expand path),
  // fetch its COMPLETE chat list and merge any missing chats into the global `chats`
  // array. The global list is capped at the 30 most-recent chats, so a project with
  // more (or older) chats would show its `chatCount` but render an empty dropdown.
  // Merging into `chats` (deduped by id, projectId injected) keeps a single source of
  // truth so rename/delete/create still flow through normally.
  //
  // Self-healing: the effect also watches `chats` — if anything replaces the global
  // array with a fresh 30-cap page and drops a loaded folder's chats (count falls
  // below the total recorded from the last fetch), it re-fetches and re-merges.
  // Without this the loss was permanent until reload (loaded-ref said "done").
  useEffect(() => {
    if (!user) return;
    expandedProjects.forEach((pid) => {
      if (projectChatsFetchingRef.current.has(pid)) return;
      if (projectChatsLoadedRef.current.has(pid)) {
        const expected = projectChatTotalsRef.current.get(pid);
        const have = chats.reduce((n, c) => (c.projectId === pid ? n + 1 : n), 0);
        if (expected === undefined || have >= expected) {
          // Track growth (new chats created into the folder) so a later drop is seen.
          if (expected !== undefined && have > expected) projectChatTotalsRef.current.set(pid, have);
          return;
        }
        // Loaded chats went missing → fall through and re-fetch.
      } else if (Date.now() - (projectChatFailAtRef.current.get(pid) ?? 0) < 30_000) {
        return; // brief backoff after a failed fetch
      }
      projectChatsFetchingRef.current.add(pid);
      projectChatsLoadedRef.current.add(pid);
      projectsApi.get(pid)
        .then((detail: any) => {
          const projChats = (detail?.chats || []).map((c: any) => ({ ...c, projectId: pid }));
          projectChatTotalsRef.current.set(pid, projChats.length);
          projectChatFailAtRef.current.delete(pid);
          if (projChats.length === 0) return;
          setChats((prev) => {
            const existing = new Set(prev.map((c) => c.id));
            const missing = projChats.filter((c: any) => !existing.has(c.id));
            return missing.length ? [...prev, ...missing] : prev;
          });
        })
        .catch(() => {
          projectChatsLoadedRef.current.delete(pid); // allow retry
          projectChatTotalsRef.current.delete(pid);
          projectChatFailAtRef.current.set(pid, Date.now());
        })
        .finally(() => { projectChatsFetchingRef.current.delete(pid); });
    });
  }, [expandedProjects, chats, user]);

  // ── Share chat handler ────────────────────────────────────────────────────
  const handleOpenShareChat = useCallback(async (chatId: string) => {
    setShareChatId(chatId);
    setShareChatUrl(null);
    setLoadingShare(true);
    try {
      const status = await sharingApi.getChatShareStatus(chatId);
      if (status.hasShareLink && status.shareUrl) {
        setShareChatUrl(status.shareUrl);
      }
    } catch {}
    setLoadingShare(false);
  }, []);

  const handleCreateShareLink = useCallback(async () => {
    if (!shareChatId) return;
    setLoadingShare(true);
    try {
      const result = await sharingApi.shareChatLink(shareChatId);
      setShareChatUrl(result.shareUrl);
      toast.success('Share link created');
    } catch {
      toast.error('Failed to create share link');
    } finally {
      setLoadingShare(false);
    }
  }, [shareChatId]);

  const handleRevokeShareLink = useCallback(async () => {
    if (!shareChatId) return;
    try {
      await sharingApi.revokeChatLink(shareChatId);
      setShareChatUrl(null);
      toast.success('Share link revoked');
    } catch {
      toast.error('Failed to revoke share link');
    }
  }, [shareChatId]);

  // ── Start new chat inside a project ─────────────────────────────────────
  // One-Digby: a project with a workspace IS a workspace project — "new chat"
  // there creates a workspace-backed chat (satellite at birth) and opens it
  // inline (CodeSessionView), instead of dropping the user on the home screen
  // with a plain composer.
  const startNewChatInProject = useCallback(async (project: Project) => {
    setCurrentChatId(null);
    setSessionId(null);
    setCurrentProjectId(project.id);
    setCurrentProjectName(project.name);
    // Expand this project in sidebar
    setExpandedProjects(prev => new Set([...prev, project.id]));
    // Close sidebar on mobile
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
    if (project.repoProvider) {
      // Workspace project → the new chat is born WITH a satellite, opened inline
      // in the coding flavor (User Space P3: the optimistic row carries
      // hasWorkspaceState so the mount rule routes it correctly).
      try {
        const sess = await codingApi.createSession(project.id, { title: 'New chat' });
        setChats(prev => [{
          id: sess.id, title: sess.title, mode: 'code', projectId: project.id, hasWorkspaceState: true,
          messages: [], createdAt: sess.createdAt, updatedAt: sess.updatedAt,
        } as CrossModelChat, ...prev]);
        setCodeInitialMessage(null);
        setCodeInitialImages([]);
        setCodeChatPlain(false);
        setCodeChatId(sess.id);
        return;
      } catch (e: any) {
        toast.error(e?.response?.data?.error || 'Could not start the chat');
        return;
      }
    }
    setCodeChatId(null);
    setCodeChatPlain(false);
    toast.info(`Now chatting in "${project.name}" `);
  }, []);

  // ── Move chat to project ─────────────────────────────────────────────────
  const handleMoveToProject = useCallback(async () => {
    if (!movingChatId) return;
    try {
      const targetProjectId = movingToProjectId || null;
      await crossModelApi.updateChat(movingChatId, { projectId: targetProjectId });
      setChats(prev => prev.map(c =>
        c.id === movingChatId ? { ...c, projectId: targetProjectId } : c
      ));
      // Refresh project counts
      projectsApi.list().then(({ owned, shared }) => {
        setOwnedProjects(owned);
        setSharedProjects(shared);
      }).catch(() => {});
      const targetProject = ownedProjects.find(p => p.id === targetProjectId);
      toast.success(targetProjectId
        ? `Moved to "${targetProject?.name || 'folder'}"`
        : 'Removed from folder'
      );
      setMovingChatId(null);
      setMovingToProjectId('');
    } catch {
      toast.error('Failed to move chat');
    }
  }, [movingChatId, movingToProjectId, ownedProjects]);

  // ── Sidebar drag-and-drop handlers (P2) ────────────────────────────────────
  // A drag survives a lost mouseup (window blur: the pointer released over
  // another app / a native sheet) — drop the chip + drop zones so the rail
  // is interactive again at once (2026-10-20; dnd-kit cancels on Escape only).
  useEffect(() => {
    if (!activeDrag) return;
    const clear = () => setActiveDrag(null);
    window.addEventListener('blur', clear);
    return () => window.removeEventListener('blur', clear);
  }, [activeDrag]);
  const handleSidebarDragStart = useCallback((event: DragStartEvent) => {
    setActiveDrag((event.active.data.current as SidebarDragItem) ?? null);
  }, []);

  /**
   * Chat → folder row: re-file the chat (optimistic, rollback + toast on error).
   * Folder → folder row: re-parent the folder (optimistic; the server is the
   * authority on cycle/depth — a 400 rolls back and surfaces its message).
   * Anything → root zone: chat becomes ungrouped / folder moves to top level.
   */
  const handleSidebarDragEnd = useCallback(async (event: DragEndEvent) => {
    const drag = event.active.data.current as SidebarDragItem | undefined;
    const overId = event.over?.id;
    setActiveDrag(null);
    if (!drag || !overId) return;
    const overData = event.over?.data.current as SidebarDragItem | { kind: 'root' } | undefined;
    const targetFolderId =
      overId === SIDEBAR_ROOT_DROP_ID
        ? null
        : overData && overData.kind === 'folder'
          ? overData.folderId
          : undefined;
    if (targetFolderId === undefined) return;

    if (drag.kind === 'chat') {
      const chat = chats.find((c) => c.id === drag.chatId);
      if (!chat || (chat.projectId ?? null) === targetFolderId) return;
      const prevProjectId = chat.projectId ?? null;
      // Optimistic update
      setChats((prev) => prev.map((c) => (c.id === drag.chatId ? { ...c, projectId: targetFolderId } : c)));
      try {
        await crossModelApi.updateChat(drag.chatId, { projectId: targetFolderId });
        const target = ownedProjectsRef.current.find((p) => p.id === targetFolderId);
        toast.success(targetFolderId ? `Moved to "${target?.name || 'folder'}"` : 'Removed from folder');
        projectsApi.list().then(({ owned, shared }) => { setOwnedProjects(owned); setSharedProjects(shared); }).catch(() => {});
      } catch (err: any) {
        // Roll back
        setChats((prev) => prev.map((c) => (c.id === drag.chatId ? { ...c, projectId: prevProjectId } : c)));
        toast.error(err?.response?.data?.error || 'Failed to move chat');
      }
      return;
    }

    // Folder move
    const folderId = drag.folderId;
    if (folderId === targetFolderId) return;
    const moved = ownedProjectsRef.current.find((p) => p.id === folderId);
    if (!moved || (moved.parentId ?? null) === targetFolderId) return;
    // Client-side pre-checks for instant feedback (server re-checks authoritatively).
    if (targetFolderId) {
      const targetPathIds = getFolderPath(targetFolderId).map((p) => p.id);
      if (targetPathIds.includes(folderId)) {
        toast.error('Cannot move a folder into itself or one of its subfolders');
        return;
      }
      const targetDepth = targetPathIds.length - 1;
      // Subtree height of the dragged folder (relative to itself).
      let subtreeHeight = 0;
      const walk = (id: string, rel: number) => {
        subtreeHeight = Math.max(subtreeHeight, rel);
        flatFolders.find((n) => n.id === id)?.children.forEach((ch) => walk(ch.id, rel + 1));
      };
      walk(folderId, 0);
      if (targetDepth + 1 + subtreeHeight > MAX_FOLDER_DEPTH) {
        toast.error(`Move would exceed the folder depth limit (max depth ${MAX_FOLDER_DEPTH})`);
        return;
      }
    }
    const prevParentId = moved.parentId ?? null;
    // Optimistic update — depth re-derives from parentId links at render time.
    setOwnedProjects((prev) => prev.map((p) => (p.id === folderId ? { ...p, parentId: targetFolderId } : p)));
    try {
      await projectsApi.move(folderId, targetFolderId);
      const target = ownedProjectsRef.current.find((p) => p.id === targetFolderId);
      toast.success(targetFolderId ? `Moved "${moved.name}" into "${target?.name || 'folder'}"` : `Moved "${moved.name}" to top level`);
      // Refresh for server-canonical depth/path.
      projectsApi.list().then(({ owned, shared }) => { setOwnedProjects(owned); setSharedProjects(shared); }).catch(() => {});
    } catch (err: any) {
      setOwnedProjects((prev) => prev.map((p) => (p.id === folderId ? { ...p, parentId: prevParentId } : p)));
      toast.error(err?.response?.data?.error || 'Failed to move folder');
    }
  }, [chats, getFolderPath, flatFolders]);

  // ── Canvas handlers ──────────────────────────────────────────────────────

  /** Update canvas content + title (user editing or AI refining) */
  const handleCanvasUpdate = useCallback(async (id: string, content: string, title?: string) => {
    setCanvases(prev => prev.map(c =>
      c.id === id
        ? { ...c, content, ...(title !== undefined && { title }), version: c.version + 1 }
        : c
    ));
    // Save to DB (best-effort, fire and forget)
    if (user && currentChatIdRef.current) {
      canvasApi.update(id, { content, ...(title !== undefined && { title }) }).catch(() => {});
    }
  }, [user]);

  /** Delete a canvas from the list */
  const handleCanvasDelete = useCallback(async (id: string) => {
    const remaining = canvases.filter(c => c.id !== id);
    setCanvases(remaining);
    // File browser (59a4454e): deleting the open file returns to the list; the
    // empty state is a designed view, so the panel stays open at zero files.
    if (activeCanvasId === id) {
      setActiveCanvasId(null);
    }
    if (user) {
      canvasApi.delete(id).catch(() => {});
    }
  }, [canvases, activeCanvasId, user]);

  /** Create a blank markdown file from the file list (59a4454e). Persisted chats
      only — the button is hidden when there is no saved chat to attach the file to. */
  const handleCreateCanvas = useCallback(async () => {
    const chatId = currentChatIdRef.current || codeChatIdRef.current;
    if (!user || !chatId) return;
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
      setCanvases(prev => [...prev, item]);
      setActiveCanvasId(item.id);
      setPanelOpen(true);
    } catch {
      toast.error('Could not create the file');
    }
  }, [user]);

  // One-Digby C5: commit the open canvas into the chat's project repo.
  const saveCanvasToProject = useCallback(async (canvas: CanvasItem) => {
    const pid = currentProjectIdRef.current;
    if (!pid) return;
    try {
      const r = await codingApi.commitKnowledge(pid, { name: canvas.title, content: canvas.content });
      toast.success(r.message || 'Saved to folder');
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'Could not save to folder');
    }
  }, []);
  // Keep the sidebar generating dot honest for inline coding runs.
  const handleCodeRunning = useCallback((cid: string, running: boolean) => {
    setGeneratingChatIds(prev => {
      const n = new Set(prev);
      if (running) { n.add(cid); codingRunMarkedAt.current.set(cid, Date.now()); }
      else { n.delete(cid); codingRunMarkedAt.current.delete(cid); }
      return n;
    });
    // The run is done — refetch the page-owned Files tab (uploads attached to
    // the last message + documents/images the agent created this turn).
    if (!running) setChatFilesRefreshKey(k => k + 1);
  }, []);

  // Stable identities for CodeSessionView props: inline arrows re-fired its
  // session-load effect on every host re-render (view blanked to a spinner on
  // each run start/stop — the send flicker, 2026-07-18).
  const handleCodeTitle = useCallback((cid: string, t: string) => {
    setChats(prev => prev.map(c => c.id === cid ? { ...c, title: t } : c));
  }, []);
  const handleCodeInitialConsumed = useCallback(() => { setCodeInitialMessage(null); setCodeInitialImages([]); setCodeInitialDisplay(null); }, []);

  /** Save a canvas edit from the page-owned Artifacts section (plain chats in
      the converged view mount these sections via plain.panelSections — C2). */


  // Sidebar chat lists hide fleet chats (the supervisor + legacy duplicates,
  // reachable via /management instead) and ARCHIVED chats (server-excluded on
  // fetch; the local filter makes an optimistic archive patch drop the row
  // instantly — restore re-adds it via the Archived section). Only sidebar
  // RENDER consumers use the filtered lists — loadChat, deep links, and
  // drag/drop still see the full `chats` list.
  const visibleChats = useMemo(
    () => chats.filter((c) => !c.archivedAt && !fleetHidden.chatIds.has(c.id)),
    [chats, fleetHidden]
  );

  // Ungrouped chats for the sidebar "CHATS" section. User Space P3 (spec §5):
  // chats filed in the hidden user-space project render here too — the sidebar
  // looks exactly as it did when they were truly ungrouped.
  const ungroupedChats = visibleChats.filter(c => !c.projectId || c.projectId === userSpaceId);

  // ── Recursive sidebar folder tree renderer (P2) ────────────────────────────
  // A folder row is a drop target (chats + folders) and draggable itself; chats
  // render nested under their folder exactly as the old flat project list did.
  // Indent grows 12px per depth level.
  const renderFolderNode = (node: FolderNode): ReactNode => {
    const isExpanded = expandedProjects.has(node.id);
    // Newest first; a folder shows only its FOLDER_CHAT_PREVIEW_COUNT most-recent
    // chats until "Show more" is clicked (the full list is already loaded — the
    // toggle is display-only, no extra fetch). visibleChats (not the full list):
    // hidden fleet chats never render in the sidebar.
    const projectChats = visibleChats
      .filter((c) => c.projectId === node.id)
      .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    const showAllChats = showAllFolderChats.has(node.id);
    // Never hide an ACTIVE chat behind the preview: the open chat and any
    // running/awaiting chats pin to the top of the folder's list, then the
    // most-recent fill the remaining preview slots.
    const isActiveChat = (c: CrossModelChat) =>
      c.id === currentChatId || effectiveGeneratingIds.has(c.id) || !!c.awaitingInput;
    // Group by parent BEFORE the preview slice (owner 2026-10-20: children
    // rendered flat and then "scrambled" under their parent once more state
    // arrived): a parent + its children are one preview unit, so nesting is
    // settled on first paint and never depends on which fetch landed first.
    const folderPreview = previewChatGroups(groupChatsByParent(projectChats), isActiveChat, FOLDER_CHAT_PREVIEW_COUNT, showAllChats);
    const hiddenChatCount = folderPreview.hiddenCount;
    // Nested-folder indent (owner 2026-10-20: "spacing of nested folders is
    // way too big … can't read things on mobile and desktop"): every level is
    // ONE container step (NEST_LEVEL_CLASS, a thin guide line + gap) — the row
    // itself carries NO extra margin. Before, each row added treeDepth × 12px
    // ON TOP of every ancestor container's +16px, so the offset grew
    // quadratically (depth 1 → 28px, depth 2 → 68px, depth 3 → 120px of a
    // 264px rail) and a third-level chat title had ~90px left to render in.
    // Rolled-up session status for a COLLAPSED folder — covers direct chats
    // AND every descendant subfolder (restores the indicators lost when
    // subfolders landed: a top-level folder shows activity anywhere inside it).
    // visibleChats (not the full list): a hidden fleet chat's activity must
    // never light a visible mixed folder's status indicator.
    const collapsedStatus = isExpanded ? null : folderAggregateStatus(node, visibleChats, effectiveGeneratingIds, currentChatId);
    return (
      <div key={node.id}>
        {/* Folder row */}
        <FolderRowDnd
          folderId={node.id}
          name={node.name}
          disabled={sharedFolderIds.has(node.id)}
          className="flex min-h-[34px] items-center gap-1 rounded-[9px] pl-2.5 pr-1 text-[13.5px] text-ink-2 hover:bg-hover hover:text-ink cursor-pointer group/proj transition-colors duration-150"
        >
          <button
            className="flex items-center gap-2.5 flex-1 min-w-0 overflow-hidden text-left"
            onClick={() => toggleProject(node.id)}
            aria-expanded={isExpanded}
          >
            {isExpanded
              ? <FolderOpen className="size-4 flex-shrink-0" strokeWidth={1.75} />
              : <Folder className="size-4 flex-shrink-0" strokeWidth={1.75} />
            }
            <span className="truncate flex-1 min-w-0">{node.name}</span>
            {node.isSharedFolder && (
              <span
                className="flex-shrink-0 ml-0.5 inline-flex text-muted-foreground"
                title={`Shared by ${(node as any).ownerName ?? 'the project owner'} — you have ${(node as any).memberRole ?? 'member'} access`}
                aria-label="Shared folder"
              >
                <Users className="size-3" />
              </span>
            )}
            <span className="text-[11.5px] text-ink-3 tabular-nums flex-shrink-0 ml-1">{node.chatCount}</span>
            {/* Per-project supervisor (2026-09-14): a supervised folder shows it in the
                sidebar itself; the toggle lives one click away in folder settings. */}
            {node.projectSupervisorEnabled === true && (
              <span
                className="flex-shrink-0 ml-1 inline-flex text-success"
                title="Project supervisor on — open folder settings to pause"
                aria-label="Project supervisor on"
              >
                <ShieldCheck className="size-3" />
              </span>
            )}
            <FolderAttentionIndicator status={collapsedStatus} />
          </button>
          {/* Folder settings — always visible on mobile, hover on desktop.
              The Fleet sidebar entry point was removed (2026-08-11, PR #195);
              the Fleet Supervisor coding chat handles the fleet. */}
          <div className="flex items-center gap-0 md:opacity-0 md:group-hover/proj:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => router.push(`/projects/${node.id}`)}
              className="p-1.5 md:p-1 rounded-md hover:bg-active text-ink-3 hover:text-ink transition-all flex-shrink-0"
              title="Open folder settings (delete, members, knowledge)"
            >
              <Settings className="size-3.5" strokeWidth={1.75} />
            </button>
          </div>
        </FolderRowDnd>
        {/* Folder contents (expanded): child folders first, then chats */}
        {isExpanded && (
          <div className={cn('space-y-px mt-px', NEST_LEVEL_CLASS)} data-folder-children={node.treeDepth + 1}>
            {/* Session summary row (2026-09-28): the folder's lanes at a glance; nothing for a folder without lanes. */}
            {(() => {
              const summary = folderSessionSummaries.get(node.id)?.summary;
              if (!summary) return null;
              return (
                <button
                  type="button"
                  data-folder-session-summary={node.id}
                  className="flex w-full items-center gap-1.5 rounded-[9px] px-2.5 py-1 text-[11.5px] text-ink-3 hover:bg-hover hover:text-ink transition-colors text-left"
                  title="Sessions in this folder — open the folder's Sessions tab"
                  onClick={() => router.push(`/projects/${node.id}`)}
                >
                  <span className={cn('size-1.5 rounded-full flex-shrink-0', summary.running > 0 ? 'bg-ok' : summary.scheduled > 0 ? 'bg-warn' : 'bg-muted-foreground/50')} />
                  <span className="truncate">{summary.text}</span>
                </button>
              );
            })()}
            {node.children.map(renderFolderNode)}
            {/* Sub-session grouping: children nest under their parent (indent +
                connector); the preview is taken over GROUPS, so a child never
                renders flat because its parent missed the preview. A group's
                DISPLAY-attached lanes (the folder supervisor's) are bounded in
                the preview; the "+N more" row reveals the rest (2026-10-21). */}
            {flattenChatGroups(folderPreview.visible, collapsedChatParents).map(({ chat, isChild, childCount, collapsed, moreChildren }) => (
              <Fragment key={chat.id}>
              <ChatRowDnd
                chatId={chat.id}
                title={chat.title}
                disabled={renamingChatId === chat.id || (!!user?.id && !!chat.userId && chat.userId !== user.id)}
                className={cn(
                  'relative group/pchat',
                  railRowClass(renamingChatId === chat.id || currentChatId === chat.id),
                  'gap-1.5',
                  isChild && 'ml-3 border-l border-line pl-2 rounded-l-none',
                  renamingChatId !== chat.id && 'cursor-pointer',
                )}
                onClick={() => renamingChatId !== chat.id && loadChat(chat)}
              >
                {renamingChatId === chat.id ? (
                  <>
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.stopPropagation(); handleRenameSubmit(chat.id); }
                        if (e.key === 'Escape') { e.stopPropagation(); setRenamingChatId(null); }
                      }}
                      onBlur={() => handleRenameSubmit(chat.id)}
                      onClick={(e) => e.stopPropagation()}
                      className="flex-1 bg-transparent border-b border-line-2 outline-none py-0.5 text-[13.5px] min-w-0"
                    />
                    <button
                      onClick={(e) => { e.stopPropagation(); setRenamingChatId(null); }}
                      className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground flex-shrink-0"
                    >
                      <X className="size-3" />
                    </button>
                  </>
                ) : (
                  <>
                    {/* Session titles (2026-09-27): "<goal> · <step>" — goal bold, step muted. */}
                    <span className="flex-1 min-w-0 truncate" data-session-title>
                      {(() => { const h = splitSessionTitle(chat.title); return h.step ? <><span className="font-medium">{h.goal}</span><span className="text-ink-3"> · {h.step}</span></> : chat.title; })()}
                    </span>
                    {childCount > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleChatChildren(chat.id); }}
                        className="flex-shrink-0 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground rounded px-1 py-0.5 hover:bg-muted transition-colors"
                        title={collapsed ? `Show ${childCount} sub-session${childCount === 1 ? '' : 's'}` : `Hide ${childCount} sub-session${childCount === 1 ? '' : 's'}`}
                      >
                        {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                        {childCount}
                      </button>
                    )}
                    {chat.hasActiveSchedule && (
                      <span title="Has an active schedule" className="flex-shrink-0 inline-flex"><CalendarClock className="size-3.5 text-muted-foreground" /></span>
                    )}
                    {/* User Space P3 (spec §6.3): the thread HAS a workspace. */}
                    {chat.hasWorkspaceState && (
                      <span title="Has a workspace" className="flex-shrink-0 inline-flex"><GitBranch className="size-3.5 text-muted-foreground" /></span>
                    )}
                    <ChatAttentionIndicator chat={chat} generating={effectiveGeneratingIds.has(chat.id)} isOpen={currentChatId === chat.id} />
                    <div className={cn(
                      "flex items-center gap-0 flex-shrink-0",
                      "md:absolute md:right-0 md:top-0 md:bottom-0 md:items-center md:pr-1 md:pl-3",
                      "md:opacity-0 md:group-hover/pchat:opacity-100 transition-opacity",
                      "md:rounded-r-md",
                      currentChatId === chat.id ? "md:bg-active" : "md:bg-hover",
                    )} onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="p-1.5 md:p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0" title="More options">
                            <MoreVertical className="size-3.5 md:h-3 md:w-3" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-40">
                          {/* 7acaa7ba: rename/share/archive/delete/move are owner-only
                              server-side — hide them on other people's chats in a
                              shared folder instead of surfacing a 403 toast. */}
                          {(!user?.id || !chat.userId || chat.userId === user.id) && (
                            <DropdownMenuItem onClick={() => { setRenamingChatId(chat.id); setRenameValue(chat.title); }}>
                              <Pencil className="size-3.5 mr-2" />
                              Rename
                            </DropdownMenuItem>
                          )}
                          {(!user?.id || !chat.userId || chat.userId === user.id) && (
                            <DropdownMenuItem onClick={() => handleOpenShareChat(chat.id)}>
                              <Share2 className="size-3.5 mr-2" />
                              Share
                            </DropdownMenuItem>
                          )}
                          {/* Archive above Delete — the primary de-clutter path (delete stays permanent) */}
                          {(!user?.id || !chat.userId || chat.userId === user.id) && (
                            <DropdownMenuItem onClick={() => void archiveChat(chat.id)}>
                              <Archive className="size-3.5 mr-2" />
                              Archive
                            </DropdownMenuItem>
                          )}
                          {/* Delete lives IN the row menu (walkthrough 2026-10-06: a
                              separate always-visible trash button on every phone row
                              doubled the per-row controls). */}
                          {(!user?.id || !chat.userId || chat.userId === user.id) && (
                            <DropdownMenuItem variant="destructive" onClick={() => setDeletingChatId(chat.id)}>
                              <Trash2 className="size-3.5 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </>
                )}
              </ChatRowDnd>
              {!!moreChildren && (
                <button
                  type="button"
                  data-more-sub-sessions={moreChildren}
                  onClick={() => setShowAllFolderChats(prev => new Set([...prev, node.id]))}
                  className="ml-3 flex min-h-[26px] w-[calc(100%-0.75rem)] items-center gap-1.5 rounded-[9px] rounded-l-none border-l border-line pl-2 text-[11.5px] text-ink-3 hover:text-ink hover:bg-hover transition-colors duration-150"
                >
                  +{moreChildren} more sub-session{moreChildren === 1 ? '' : 's'}
                </button>
              )}
              </Fragment>
            ))}
            {hiddenChatCount > 0 && (
              <button
                onClick={() => setShowAllFolderChats(prev => new Set([...prev, node.id]))}
                className="flex min-h-[30px] items-center gap-2 rounded-[9px] px-2.5 text-[12.5px] text-ink-3 hover:text-ink hover:bg-hover w-full transition-colors duration-150"
              >
                <ChevronDown className="size-3" />
                Show {hiddenChatCount} more
              </button>
            )}
            {showAllChats && folderPreview.overflow && (
              <button
                onClick={() => setShowAllFolderChats(prev => { const next = new Set(prev); next.delete(node.id); return next; })}
                className="flex min-h-[30px] items-center gap-2 rounded-[9px] px-2.5 text-[12.5px] text-ink-3 hover:text-ink hover:bg-hover w-full transition-colors duration-150"
              >
                <ChevronUp className="size-3" />
                Show less
              </button>
            )}
            {/* 7acaa7ba: editors can create chats in a shared folder; viewers
                cannot (createProjectChat 403s) — hide rather than surface the error. */}
            {(!node.isSharedFolder || (node as any).memberRole !== 'viewer') && (
              <button
                onClick={() => startNewChatInProject(node)}
                className="flex min-h-[30px] items-center gap-2 rounded-[9px] px-2.5 text-[12.5px] text-ink-3 hover:text-ink hover:bg-hover w-full transition-colors duration-150"
              >
                <Plus className="size-3" />
                New chat
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── Session Workspace panel sections (C2, ticket 71b1fec6, design D1) ──
  // Built through the capability-keyed section registry — the same table
  // CodeSessionView's in-view panel uses — so mounts can never drift
  // on WHICH sections exist. C3: the page-level aside/drawer is RETIRED —
  // this array now feeds ONLY CodeSessionView via plain.panelSections
  // (plain coded sessions; the chatless fallback derives its capped copy
  // below; guests get []). Kid accounts never get Schedules (owner surface).
  // NO fleet section (owner scoping principle 2026-09-07): the panel pertains
  // to THIS chat — the account-wide fleet dashboard lives on /management, and
  // plain chats carry no in-panel Project Pulse (the dashboard project titles
  // + the project page are the owner-approved pulse surfaces).
  const pagePanelSections: WorkspaceSection[] = workspaceSectionIds({ kind: 'plain', isKid })
    .map((sid): WorkspaceSection | null => {
      switch (sid) {
        // Files = ONE list (owner 2026-10-07: "not artifacts it should just
        // all be files"): uploads + generated files + the chat's documents
        // (canvases) together; a document opens in the editor in place of the
        // list. Chatless sessions get the document panel alone (uploads are
        // chat-keyed) — its list is titled "Files" too.
        case 'files': {
          const filesChatId = currentChatId || codeChatId;
          return { id: sid, label: WORKSPACE_SECTION_LABELS[sid], icon: <Paperclip className="size-3.5" />, node: (
            <FilesPane
              docOpen={!!activeCanvasId}
              filesNode={filesChatId ? (
                <ChatFilesSection
                  chatId={filesChatId}
                  refreshKey={chatFilesRefreshKey}
                  docs={canvases}
                  onOpenDoc={setActiveCanvasId}
                  onNewFile={user ? handleCreateCanvas : undefined}
                />
              ) : undefined}
              docNode={(
                <CanvasPanel
                  canvases={canvases}
                  activeCanvasId={activeCanvasId}
                  onUpdateCanvas={handleCanvasUpdate}
                  onDeleteCanvas={handleCanvasDelete}
                  onSaveToProject={currentProjectId ? saveCanvasToProject : undefined}
                  onSelectCanvas={setActiveCanvasId}
                  onCreateCanvas={user && filesChatId ? handleCreateCanvas : undefined}
                />
              )}
            />
          ) };
        }
        // Schedules tab (rm9): plain chats carry schedules too (detached
        // chat-agent firings) — same tab as coding sessions, chatId-driven.
        case 'schedules': return { id: sid, label: WORKSPACE_SECTION_LABELS[sid], icon: <CalendarClock className="size-3.5" />, node: (
          <SchedulesSection chatId={currentChatId || codeChatId} />
        ) };
        // 'settings' (2026-09-09) is built ONCE below (settingsSection) and
        // appended LAST by CodeSessionView for both kinds — like 'browser'.
        // 'overview' is coding-only (codingApi data — design D2); the registry
        // never emits it for kind:'plain'.
        default: return null;
      }
    })
    .filter((s): s is WorkspaceSection => s !== null);

  // ── Settings tab (owner directive 2026-09-09): the ONE home for the
  // per-session controls (autonomy / attach / workspace chrome) — mounted by
  // the view for every non-guest session kind. The header carries no menus
  // since 2026-10-06 (owner: "all that should be in the sidebar or settings").
  const settingsSection: WorkspaceSection | null = user && (codeChatId || chatlessActive) && !chatlessActive?.guest ? {
    id: 'settings',
    label: WORKSPACE_SECTION_LABELS.settings,
    node: (
      <SessionSettingsSection
        isLoggedIn={!!user}
        isKid={isKid}
        // roster 2026-10-06 B-3: no Patience group (Digby picks depth per message); kids keep their "Kids mode" note.
        showPatience={!(codeChatId && !codeChatPlain)}
        onAttachWorkspace={
          user && !isKid && codeChatId && codeChatPlain && !effectiveGeneratingIds.has(codeChatId)
            ? attachWorkspace
            : undefined
        }
        onOpenAutonomy={
          user && !isKid && (codeChatId || currentChatId)
            ? () => setAutonomyChatId(codeChatId || currentChatId)
            : undefined
        }
        instructionsChatId={user && !isKid ? (codeChatId || currentChatId) : null}
        // Ghost mode (2026-10-22): the owner's own PLAIN chat only — coding
        // sessions (codeChatPlain false), supervisor lanes and other people's
        // chats in shared folders never offer it. The ONE rule lives in
        // signedInGhostChatId (lib/ghost-composer.ts ghostEligibleChatId — the
        // composer Ghost button reads it too). List rows carry isSupervisor
        // AND isProjectSupervisor (the row select gained the latter in the
        // composer-toggle review fix — a Project Supervisor chat used to show a
        // switch whose save 400'd); a minimal row (open-by-id / search) that
        // lacks them is hidden by GhostModeRow's own read.
        ghostChatId={signedInGhostChatId}
        // The row's posture keeps the switch in step with the composer toggle
        // (ghost composer toggle, 2026-10-22) — undefined until it is known.
        // NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED=1 passes no hint: the
        // switch self-loads exactly as before ('Loading…', disabled until read).
        ghostMode={codeChatId && !ghostComposerToggleDisabled() ? chats.find(c => c.id === codeChatId)?.ghostMode : undefined}
        // Patch the sidebar row on save — the header badge reads chats[].ghostMode —
        // and hold the flip against a stale list row (the same rule as the composer).
        onGhostChanged={(chatId, ghostMode, saved) => {
          noteGhostFlip(chatId, ghostMode, saved);
          setChats(prev => prev.map(c => c.id === chatId ? { ...c, ghostMode } : c));
        }}
        coding={codeChrome}
      />
    ),
  } : null;

  // C3: the chatId-less FALLBACK (signed-in, createChat failed) mounts the
  // registry's chatless capability set — plain minus the chat-keyed sections
  // (Files uploads/generated docs AND Schedules are chat-keyed). Derived from
  // the already-built array so the node closures are shared, intersected with
  // the registry's OWN chatless answer so this filter can never drift from the
  // capability table; kid withholding composes via pagePanelSections.
  // (Guests get no panel at all — the fork passes [] for guest mounts.)
  const chatlessSectionIds = new Set<string>(workspaceSectionIds({ kind: 'plain', isKid, chatless: true }));
  const pagePanelSectionsChatless: WorkspaceSection[] = pagePanelSections.filter(s => chatlessSectionIds.has(s.id));

  // ── Chat header (Digby Frontier, 2026-10-06) ── The in-flow 56px header
  // (FloatingChrome) renders at the top of the CHAT column: CodeSessionView
  // mounts it above its transcript (the side panel keeps its own header) and
  // the home screen mounts it above the hero. Title = the open conversation
  // (null on home ⇒ no title button / Share pill).
  const headerChatTitle: string | null = (codeChatId || chatlessActive)
    ? (chatlessActive?.guest
      ? (guestSessions.find(g => g.id === activeGuestId)?.title || 'New chat')
      : codeChatId
        ? (chats.find(c => c.id === codeChatId)?.title || 'New chat')
        : 'New chat')
    : null;
  // Rename / Share are owner-only server-side (7acaa7ba) — offered only on the
  // signed-in owner's saved chat.
  const headerCanManage = !!user && !!codeChatId && (() => {
    const row = chats.find(c => c.id === codeChatId);
    return !row?.userId || row.userId === user.id;
  })();
  const headerNode = (
      <FloatingChrome
        isLoggedIn={!!user}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
        onNewChat={user ? startNewChat : startNewGuestChat}
        // Side-panel toggle: one page-owned state (panelOpen) drives the
        // panel for EVERY mounted session view — plain, coding, and the
        // chatless fallback. Never on home (no renderer), never for guests
        // (no panel). The panel's Settings tab holds the per-chat controls
        // the old title / ⋯ menus duplicated (attach a workspace, autonomy,
        // agent mode, branch, PR) — owner 2026-10-06: one home per action.
        showWorkspaceToggle={(!!codeChatId || !!chatlessActive) && !chatlessActive?.guest}
        workspaceOpen={panelOpen}
        onToggleWorkspace={() => setPanelOpen(o => !o)}
        onLogin={() => router.push('/login')}
        onSignup={() => { trackVisitEvent('signup_cta', { where: 'header' }, { flush: true }); router.push('/login?signup=true'); }}
        chatTitle={headerChatTitle}
        // Ghost mode (2026-10-22): guests pass their browser-local per-session
        // flag; the signed-in createChat-failure fallback its ARMED posture;
        // signed-in chats the open chat row's ghostMode (absent on older
        // backends = false) — every composer / panel flip patches that row, so
        // the badge flips with it. The badge shows the honest one-liner on hover.
        ghostActive={
          chatlessActive?.guest
            ? guestGhost
            : chatlessActive
              ? !!chatlessActive.ghost // the signed-in fallback's armed posture
              : !!chats.find(c => c.id === codeChatId)?.ghostMode
        }
        onShare={headerCanManage && codeChatId && !isKid ? () => void handleOpenShareChat(codeChatId) : undefined}
      />
  );

  return (
    <div data-app-shell className="fixed inset-0 flex flex-col bg-background overflow-hidden" style={{ height: 'var(--app-height, 100dvh)', top: 'var(--app-top, 0px)' }}>
      {/* Auth-boot failure banner (2026-10-09 hang fix): a transient /auth/me
          failure keeps the session INTACT — this banner says so and offers
          Retry, instead of silently rendering the anonymous home (the
          "perpetually spinning hat" look) for a signed-in user. */}
      {authBootFailed && (
        <div className="flex items-center justify-between gap-3 border-b border-warn/30 bg-warn/10 px-4 py-2 text-[13px] text-ink" role="alert">
          <span className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-warn flex-shrink-0" aria-hidden />
            Couldn&apos;t reach Digby — your session is saved. Check your connection and retry.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-warn/40 px-3 text-xs"
            onClick={() => { authBootRetriedRef.current = 0; runAuthBootstrap(); }}
          >
            <RefreshCw className="size-3.5" strokeWidth={1.75} /> Retry
          </Button>
        </div>
      )}
      {/* Google Ad Manager (GPT) REMOVED (todo 9a3e82af): the streaming
          "thinking" ad slot and its loader are gone — Digby is ad-free
          in-product. Do not reintroduce an ad library here; the gate at
          frontend/lib/ad-free.test.ts fails the build if one returns. */}
      {/* ── Body: sidebar + main ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Sidebar (authenticated only) ── The shell is the shared AppRail
            primitive (Phase 1): mobile drawer with dialog semantics (backdrop,
            focus trap, Esc, inert-when-closed) + desktop static column driven
            by the shared resize controller. Content below is unchanged. */}
        {user && (
          <AppRail
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            label="Chat sidebar"
            resizable={sidebarRail}
            resizeLabel="Resize sidebar"
          >
              {/* ── Digby Frontier rail head (2026-10-06): brand row (hat ·
                  "Digby" · collapse), then the primary actions — New chat,
                  Search (deep search, ⌘K), and the decisions / needs-input
                  queues as quiet rows that expand their cards inline. ── */}
              <RailBrandRow onCollapse={() => setSidebarOpen(false)} />
              <div className="flex flex-shrink-0 flex-col gap-px px-2 pt-1 pb-2">
                <RailActionRow
                  primary
                  icon={<SquarePen className="size-[17px]" strokeWidth={1.75} />}
                  label="New chat"
                  hint={<span className="hidden md:inline">⌘⇧O</span>}
                  onClick={startNewChat}
                  title="New chat (⌘⇧O)"
                />
                {/* Deep search across all chats + messages (ticket 4fd1de3c) —
                    also opens via ⌘K / Ctrl+K. Adults-only (kids get a stripped UI). */}
                {!isKid && (
                  <RailActionRow
                    icon={<Search className="size-[17px]" strokeWidth={1.75} />}
                    label="Search"
                    hint={<span className="hidden md:inline">⌘K</span>}
                    onClick={() => setDeepSearchOpen(true)}
                    title="Search all chats and messages (⌘K)"
                  />
                )}

                {/* ── Decisions needed (ticket 43212128) — the FIRST-CLASS queue,
                    above every other pending item. Flagged owner questions NEVER
                    expire: one-tap approve/decline (posts back into the source
                    chat + wakes it). Collapsed by default (1101e72c) to ONE row
                    ("{n} decisions need you"); the cards expand inline. ── */}
                {pendingOwnerDecisions.length > 0 && (
                  <>
                    <RailActionRow
                      icon={<WarnDot />}
                      label={`${pendingOwnerDecisions.length} decision${pendingOwnerDecisions.length === 1 ? ' needs' : 's need'} you`}
                      hint={<ChevronRight className={cn('size-3.5 text-ink-3 transition-transform duration-200', decisionsExpanded && 'rotate-90')} />}
                      onClick={() => setDecisionsExpanded(v => !v)}
                      aria-expanded={decisionsExpanded}
                    />
                    {decisionsExpanded && (
                      // Cards scroll inside their own capped track — a long queue
                      // must never push the chat list out of the rail.
                      <div className="dg-pop max-h-72 overflow-y-auto space-y-1.5 px-0.5 pt-1 pb-1.5">
                        {pendingOwnerDecisions.map((p) => (
                          <OwnerQuestionCard
                            key={`${p.chatId}:${p.id}`}
                            p={p}
                            compact
                            busy={resolvingDecisionId === p.id}
                            onAnswer={handleAnswerOwnerQuestion}
                            onDismiss={handleDismissOwnerQuestion}
                            onOpenChat={handleOpenPendingConfirmation}
                            onOpenInbox={() => router.push('/management?tab=inbox')}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}

                {/* ── Pending confirmations — a run blocked on a human reply stays
                    visible from anywhere. Polled via refreshPendingConfirmations;
                    click jumps to the blocked chat. Content diet (Phase 1 item 6):
                    DEFAULT COLLAPSED to one row; Confirm/Cancel/Dismiss live in the
                    expanded cards. (Owner questions have their own row above.) ── */}
                {pendingOtherItems.length > 0 && (
                  <>
                    <RailActionRow
                      icon={pendingOtherItems.some((p) => !p.expired && p.kind !== 'owner_question')
                        ? <WarnDot />
                        : <span aria-hidden="true" className="block size-[7px] rounded-full bg-ink-3/60" />}
                      label={(() => {
                        // Expired traces don't "need input" — count only the live ones.
                        // Owner 2026-09-22: a supervisor-triaged owner question is not a
                        // "needs your input" item — say what it is.
                        const triagedQs = pendingOtherItems.filter((p) => p.kind === 'owner_question').length;
                        const live = pendingOtherItems.filter((p) => !p.expired && p.kind !== 'owner_question').length;
                        const parts: string[] = [];
                        if (live > 0) parts.push(`${live} need${live === 1 ? 's' : ''} your input`);
                        if (triagedQs > 0) parts.push(`${triagedQs} question${triagedQs === 1 ? '' : 's'} your supervisor is handling`);
                        return parts.length ? parts.join(' · ') : 'Recently expired';
                      })()}
                      hint={<ChevronRight className={cn('size-3.5 text-ink-3 transition-transform duration-200', needsInputExpanded && 'rotate-90')} />}
                      onClick={() => setNeedsInputExpanded(v => !v)}
                      aria-expanded={needsInputExpanded}
                    />
                    {needsInputExpanded && (
                      <div className="dg-pop max-h-72 overflow-y-auto space-y-1.5 px-0.5 pt-1 pb-1.5">
                      {pendingOtherItems.slice(0, 3).map((p) => (
                        p.kind === 'confirmation' && p.expired ? (
                          /* Expired-unresolved trace (f789d84e): the card lapsed with no
                             decision — show WHAT vanished instead of vanishing silently. */
                          <div
                            key={`${p.chatId}:${p.id}`}
                            className="rounded-xl border border-line bg-raised px-3 py-2.5 opacity-80"
                          >
                            <span className="block text-[13px] font-medium truncate text-ink-2">{p.title || 'Untitled chat'}</span>
                            <span className="block text-[12px] text-ink-3 truncate" title={p.question}>
                              {p.question}
                            </span>
                            <span className="block mt-1 text-[11.5px] text-ink-3">
                              Expired unconfirmed — ask the chat to re-stage it if still wanted.
                            </span>
                          </div>
                        ) : p.kind === 'confirmation' && p.stale ? (
                          /* Stale-but-pending (7705fec2): the card persists until the
                             owner acts, but the staged args are past the execution-
                             freshness horizon — Confirm would refuse, so offer only
                             Dismiss plus the re-stage hint. */
                          <div
                            key={`${p.chatId}:${p.id}`}
                            className="rounded-xl border border-line bg-raised px-3 py-2.5"
                          >
                            <span className="block text-[13px] font-medium truncate text-ink">{p.title || 'Untitled chat'}</span>
                            <span className="block text-[12px] leading-snug line-clamp-2 break-words text-ink-2" title={p.question}>
                              {p.question}
                            </span>
                            <span className="block mt-1 text-[11.5px] text-ink-3">
                              Staged too long ago to run safely — ask the chat to re-stage it if still wanted.
                            </span>
                            <div className="mt-2 flex gap-1.5">
                              <button
                                onClick={() => void handleResolvePendingAction(p, 'cancel')}
                                className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-hover hover:border-line-2 transition-colors"
                              >
                                Dismiss
                              </button>
                            </div>
                          </div>
                        ) : p.kind === 'confirmation' ? (
                          <div
                            key={`${p.chatId}:${p.id}`}
                            className="rounded-xl border border-line bg-raised px-3 py-2.5"
                          >
                            <span className="block text-[13px] font-medium truncate text-ink">{p.title || 'Untitled chat'}</span>
                            <span className="block text-[12px] leading-snug line-clamp-2 break-words text-ink-2" title={p.question}>
                              {p.question}
                            </span>
                            <div className="mt-2 flex gap-1.5">
                              <button
                                onClick={() => void handleResolvePendingAction(p, 'confirm')}
                                className="rounded-full bg-send px-3 py-1 text-[12px] font-medium text-send-ink hover:opacity-90 active:scale-[0.97] transition"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => void handleResolvePendingAction(p, 'cancel')}
                                className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-hover hover:border-line-2 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : p.kind === 'owner_question' ? (
                          /* A supervisor-triaged owner question (owner 2026-09-22): the
                             same answerable card as the decisions queue — options as
                             buttons, honest "supervisor is answering first" line —
                             instead of a bare link that opened a chat with nothing to act on. */
                          <OwnerQuestionCard
                            key={`${p.chatId}:${p.id}`}
                            p={p}
                            compact
                            busy={resolvingDecisionId === p.id}
                            onAnswer={handleAnswerOwnerQuestion}
                            onDismiss={handleDismissOwnerQuestion}
                            onOpenChat={handleOpenPendingConfirmation}
                            onOpenInbox={() => router.push('/management?tab=inbox')}
                          />
                        ) : (
                          /* Tool approval / ask_user question (owner 2026-10-20: "i
                             cant click approve or allow or anything from this sidebar
                             question"): the card used to be a bare link into the chat
                             with nothing to act on. It now answers INLINE through the
                             same endpoints the chat views use — Allow / Always / Deny
                             for an approval, the question's options as buttons — and
                             keeps "Open chat" as the secondary action. */
                          <div
                            key={`${p.chatId}:${p.id}`}
                            data-pending-card={p.kind}
                            className="rounded-xl border border-line bg-raised px-3 py-2.5"
                          >
                            <button
                              type="button"
                              onClick={() => handleOpenPendingConfirmation(p)}
                              className="block w-full text-left"
                              title="Open the chat"
                            >
                              <span className="block text-[13px] font-medium truncate text-ink">{p.title || 'Untitled chat'}</span>
                              <span className="block text-[12px] leading-snug line-clamp-2 break-words text-ink-2" title={p.question}>
                                {p.kind === 'approval' ? 'Approval: ' : ''}{p.question}
                              </span>
                            </button>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              {p.kind === 'approval' ? (
                                <>
                                  <button
                                    type="button"
                                    disabled={resolvingDecisionId === p.id}
                                    onClick={() => void handleResolvePendingApproval(p, 'allow')}
                                    className="rounded-full bg-send px-3 py-1 text-[12px] font-medium text-send-ink hover:opacity-90 active:scale-[0.97] transition disabled:opacity-50"
                                  >
                                    Allow
                                  </button>
                                  <button
                                    type="button"
                                    disabled={resolvingDecisionId === p.id}
                                    onClick={() => void handleResolvePendingApproval(p, 'always')}
                                    className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-hover hover:border-line-2 transition-colors disabled:opacity-50"
                                    title="Allow this tool for the rest of the run"
                                  >
                                    Always
                                  </button>
                                  <button
                                    type="button"
                                    disabled={resolvingDecisionId === p.id}
                                    onClick={() => void handleResolvePendingApproval(p, 'deny')}
                                    className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-hover hover:border-line-2 hover:text-destructive transition-colors disabled:opacity-50"
                                  >
                                    Deny
                                  </button>
                                </>
                              ) : (
                                (p.options ?? []).slice(0, 4).map((opt) => (
                                  <button
                                    key={opt}
                                    type="button"
                                    disabled={resolvingDecisionId === p.id}
                                    onClick={() => void handleAnswerPendingQuestion(p, opt)}
                                    className="max-w-full truncate rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-hover hover:border-line-2 transition-colors disabled:opacity-50"
                                    title={opt}
                                  >
                                    {opt}
                                  </button>
                                ))
                              )}
                              <button
                                type="button"
                                onClick={() => handleOpenPendingConfirmation(p)}
                                className="ml-auto text-[11.5px] text-ink-3 hover:text-ink transition-colors"
                              >
                                Open chat
                              </button>
                            </div>
                          </div>
                        )
                      ))}
                      {pendingOtherItems.length > 3 && (
                        <p className="px-2 text-[11.5px] text-ink-3">+{pendingOtherItems.length - 3} more…</p>
                      )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Sidebar scrollable content (DndContext covers folder/chat rows) */}
              <DndContext
                sensors={sidebarSensors}
                collisionDetection={sidebarCollisionDetection}
                onDragStart={handleSidebarDragStart}
                onDragEnd={handleSidebarDragEnd}
                onDragCancel={() => setActiveDrag(null)}
              >
              <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-3">

                {/* ── FOLDERS SECTION ── */}
                {/* Sentence-case label (Digby Frontier); the label itself
                    toggles collapse, + creates a folder. */}
                <div>
                  <RailSectionLabel
                    first
                    onClick={() => setProjectsSectionCollapsed(prev => !prev)}
                    expanded={!projectsSectionCollapsed}
                    action={
                      <RailLabelButton title="New folder" onClick={() => setShowNewProjectDialog(true)}>
                        <FolderPlus className="size-3.5" strokeWidth={1.75} />
                      </RailLabelButton>
                    }
                  >
                    Folders
                  </RailSectionLabel>

                  {!projectsSectionCollapsed && (!sidebarHydrated || treeProjects.length === 0 ? (
                    sidebarHydrated ? (
                      <button
                        onClick={() => setShowNewProjectDialog(true)}
                        className={cn(railRowClass(false), 'w-full text-left')}
                      >
                        <FolderPlus className="size-4 flex-shrink-0" strokeWidth={1.75} />
                        New folder
                      </button>
                    ) : (
                      // Ticket 26edb492: the folder tree is still fetching —
                      // skeleton rows instead of the bare "New Folder" button,
                      // which reads as "your folders are gone" on a slow first
                      // load.
                      <div className="space-y-1 px-1 py-1" role="status" aria-label="Loading folders">
                        <Skeleton className="h-6 w-3/4" />
                        <Skeleton className="h-6 w-full" />
                        <Skeleton className="h-6 w-2/3" />
                      </div>
                    )
                  ) : (
                    <div className="space-y-px">
                      {folderTree.map(renderFolderNode)}
                      {activeDrag && (
                        <RootDropZone
                          label={activeDrag.kind === 'chat'
                            ? 'Drop here to remove from folder'
                            : 'Drop here to move to top level'}
                        />
                      )}
                    </div>
                  ))}
                </div>

                {/* ── SHARED WITH ME SECTION ──
                    (Ticket 7acaa7ba: retired) Shared folders now render in the
                    FOLDERS tree above with their chats nested and a shared badge —
                    this flat list navigated to a route that doesn't exist
                    (/projects/:id) and never showed the folder's chats. */}

                {/* ── UNGROUPED CHATS SECTION ── */}
                {/* Grouped by recency (Today / Yesterday /
                    Previous 7 days / …) under sentence-case labels (Digby
                    Frontier) — replaces the single uppercase "CHATS" list. New
                    chat lives in the rail head; the first label keeps the
                    collapse toggle. */}
                <div>
                  {!chatsSectionCollapsed && (!railReady || (ungroupedChats.length === 0 && treeProjects.length === 0)) && (
                    !railReady ? (
                      // Ticket 26edb492: the first chats fetch is still in
                      // flight — the rail used to fall through to "No chats
                      // yet" (or plain blank) here, which reads as "my chats
                      // were deleted" when the list is just slow. Skeleton
                      // rows + explicit "Loading chats…" copy instead. Copy +
                      // spinner idiom: ConnectedInstancesSection "Loading
                      // chats…".
                      <div className="py-2 px-1 space-y-1" role="status" aria-label="Loading chats">
                        <div className="flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground">
                          <Loader2 className="size-3 animate-spin" />
                          Loading chats…
                        </div>
                        <Skeleton className="h-7 w-full" />
                        <Skeleton className="h-7 w-5/6" />
                        <Skeleton className="h-7 w-2/3" />
                      </div>
                    ) : chatListError ? (
                      // Honest failure (P4) — never render "No chats yet" over
                      // an errored fetch; Retry re-runs the first-page load.
                      <LoadErrorState className="py-4" message="Couldn't load your chats." onRetry={() => void fetchChatList()} />
                    ) : (
                      <Empty className="py-4 px-3 gap-2 border-none">
                        <EmptyHeader>
                          <EmptyDescription className="text-xs">No chats yet. Start chatting!</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    )
                  )}
                  {railReady && ungroupedChats.length > 0 && groupRowsByRecency(
                    flattenChatGroups(groupChatsByParent(ungroupedChats), collapsedChatParents),
                  ).map((section, sectionIdx) => (chatsSectionCollapsed && sectionIdx > 0) ? null : (
                    <div key={section.bucket}>
                      <RailSectionLabel
                        onClick={sectionIdx === 0 ? () => setChatsSectionCollapsed(prev => !prev) : undefined}
                        expanded={sectionIdx === 0 ? !chatsSectionCollapsed : undefined}
                      >
                        {section.label}
                      </RailSectionLabel>
                    {!chatsSectionCollapsed && (
                    <div className="space-y-px">
                      {/* Sub-session grouping: children nest under their parent
                          (indent + connector); a parent off this list = flat row. */}
                      {section.rows.map(({ chat, isChild, childCount, collapsed }) => (
                        <ChatRowDnd
                          key={chat.id}
                          chatId={chat.id}
                          title={chat.title}
                          disabled={renamingChatId === chat.id}
                          className={cn(
                            'group relative w-full',
                            railRowClass(renamingChatId === chat.id || currentChatId === chat.id),
                            'gap-1.5',
                            isChild && 'ml-3 w-auto border-l border-line pl-2 rounded-l-none',
                            renamingChatId !== chat.id && 'cursor-pointer',
                          )}
                          onClick={() => renamingChatId !== chat.id && loadChat(chat)}
                        >
                          {renamingChatId === chat.id ? (
                            <>
                              <input
                                autoFocus
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') { e.stopPropagation(); handleRenameSubmit(chat.id); }
                                  if (e.key === 'Escape') { e.stopPropagation(); setRenamingChatId(null); }
                                }}
                                onBlur={() => handleRenameSubmit(chat.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="flex-1 bg-transparent border-b border-line-2 outline-none py-0.5 text-[13.5px] min-w-0"
                              />
                              <button
                                onClick={(e) => { e.stopPropagation(); setRenamingChatId(null); }}
                                className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground flex-shrink-0"
                              >
                                <X className="size-3" />
                              </button>
                            </>
                          ) : (
                            <>
                              <span className={cn("flex-1 min-w-0 truncate leading-snug", TEXT_SIZE_MAP[prefs.chatTextSize].chatTitle)}>{chat.title}</span>
                              {childCount > 0 && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); toggleChatChildren(chat.id); }}
                                  className="flex-shrink-0 inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground rounded px-1 py-0.5 hover:bg-muted transition-colors"
                                  title={collapsed ? `Show ${childCount} sub-session${childCount === 1 ? '' : 's'}` : `Hide ${childCount} sub-session${childCount === 1 ? '' : 's'}`}
                                >
                                  {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
                                  {childCount}
                                </button>
                              )}
                              {chat.hasActiveSchedule && (
                                <span title="Has an active schedule" className="flex-shrink-0 inline-flex"><CalendarClock className="size-3.5 text-muted-foreground" /></span>
                              )}
                              {/* User Space P3 (spec §6.3): the thread HAS a workspace. */}
                              {chat.hasWorkspaceState && (
                                <span title="Has a workspace" className="flex-shrink-0 inline-flex"><GitBranch className="size-3.5 text-muted-foreground" /></span>
                              )}
                              <ChatAttentionIndicator chat={chat} generating={effectiveGeneratingIds.has(chat.id)} isOpen={currentChatId === chat.id} />
                              {/* Actions: ONE ⋮ menu (Rename · Share · Move · Archive · Delete) — absolute overlay on desktop (no layout shift), inline on mobile */}
                              <div className={cn(
                                "flex items-center gap-0 flex-shrink-0",
                                "md:absolute md:right-0 md:top-0 md:bottom-0 md:items-center md:pr-1 md:pl-3",
                                "md:opacity-0 md:group-hover:opacity-100 transition-opacity",
                                "md:rounded-r-md",
                                currentChatId === chat.id ? "md:bg-active" : "md:bg-hover",
                              )} onClick={(e) => e.stopPropagation()}>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button className="p-1.5 md:p-1 rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-colors flex-shrink-0" title="More options">
                                      <MoreVertical className="size-3.5 md:h-3 md:w-3" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-40">
                                    <DropdownMenuItem onClick={() => { setRenamingChatId(chat.id); setRenameValue(chat.title); }}>
                                      <Pencil className="size-3.5 mr-2" />
                                      Rename
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={() => handleOpenShareChat(chat.id)}>
                                      <Share2 className="size-3.5 mr-2" />
                                      Share
                                    </DropdownMenuItem>
                                    {visibleProjects.length > 0 && (
                                      <DropdownMenuItem onClick={() => { setMovingChatId(chat.id); setMovingToProjectId(''); }}>
                                        <FolderOpen className="size-3.5 mr-2" />
                                        Move to Folder
                                      </DropdownMenuItem>
                                    )}
                                    {/* Archive above Delete — the primary de-clutter path (delete stays permanent) */}
                                    <DropdownMenuItem onClick={() => void archiveChat(chat.id)}>
                                      <Archive className="size-3.5 mr-2" />
                                      Archive
                                    </DropdownMenuItem>
                                    {/* Delete in the row menu — one control per row (walkthrough 2026-10-06). */}
                                    <DropdownMenuItem variant="destructive" onClick={() => setDeletingChatId(chat.id)}>
                                      <Trash2 className="size-3.5 mr-2" />
                                      Delete
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </>
                          )}
                        </ChatRowDnd>
                      ))}
                    </div>
                    )}
                    </div>
                  ))}
                  {!chatsSectionCollapsed && hasMoreChats && (
                    <div className="pt-1">
                      <button
                        onClick={loadMoreChats}
                        disabled={loadingMoreChats}
                        className="w-full text-center text-[12px] text-ink-3 hover:text-ink transition-colors py-1.5 rounded-[9px] hover:bg-hover disabled:opacity-50"
                      >
                        {loadingMoreChats
                          ? <span className="flex items-center justify-center gap-1.5"><Loader2 className="size-3 animate-spin" />Loading…</span>
                          : 'Load more'}
                      </button>
                    </div>
                  )}
                </div>

                {/* ── CONNECTED INSTANCES (Digby Edge, ADMIN only) — paired
                    self-hosted instances, browsable + interactive via the tunnel. */}
                {isAdmin && <ConnectedInstancesSection />}

                {/* ── ARCHIVED — browse + restore archived chats/folders (collapsed
                    by default; lazy fetch on expand). Restores re-sync the live
                    lists: the chat list re-fetches, and a restored folder pulls
                    its chats back with it (they were hidden via the folder). */}
                {!isKid && (
                  <ArchivedSection
                    refreshToken={archiveVersion}
                    onRestoredChat={() => { void fetchChatList(); }}
                    onRestoredProject={() => {
                      void fetchChatList();
                      projectsApi.list().then(({ owned, shared }) => { setOwnedProjects(owned); setSharedProjects(shared); }).catch(() => {});
                    }}
                  />
                )}

              </div>{/* /scrollable content */}
              {/* Floating chip that follows the pointer while dragging.
                  pointer-events-none (2026-10-20): the chip sits under the
                  cursor, so a drag whose mouseup the shell lost (released
                  outside the window, a native menu) used to leave a fixed
                  non-scrollable element eating every wheel event over the
                  rail — "can't scroll the sidebar" until Escape. */}
              <DragOverlay className="pointer-events-none">
                {activeDrag ? (
                  <div className="flex items-center gap-1.5 rounded-[9px] border border-line bg-raised px-2.5 py-1.5 text-[13px] shadow-(--pop)">
                    {activeDrag.kind === 'folder'
                      ? <FolderOpen className="size-3 text-ink-3 flex-shrink-0" />
                      : <MessageSquare className="size-3 text-ink-3 flex-shrink-0" />}
                    <span className="max-w-[180px] truncate">
                      {activeDrag.kind === 'folder' ? activeDrag.name : activeDrag.title}
                    </span>
                  </div>
                ) : null}
              </DragOverlay>
              </DndContext>

              {/* ── Footer (Digby Frontier): avatar · name · email · Settings.
                  The Settings glyph opens Account directly; the row opens the
                  account menu that now holds the old bottom links (Files,
                  Management + its decisions badge, Help, legal, Log out). ── */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <RailFooter
                    name={[user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.email || 'Account'}
                    email={user.email}
                    title="Account menu"
                    aria-label="Account menu"
                    onOpenSettings={isKid ? undefined : () => router.push('/account')}
                    trailing={!isKid && pendingOwnerDecisions.length > 0 ? (
                      <span
                        className="flex-shrink-0 rounded-full bg-warn px-1.5 py-0.5 text-[10px] font-semibold leading-none text-send-ink dark:text-background"
                        title={`${pendingOwnerDecisions.length} decision${pendingOwnerDecisions.length === 1 ? '' : 's'} needed — Management → Inbox`}
                      >
                        {pendingOwnerDecisions.length}
                      </span>
                    ) : undefined}
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-[240px] rounded-xl">
                  {/* Digby Kids: no Files / Settings / Management for child accounts. */}
                  {!isKid && (
                    <>
                      <DropdownMenuItem onClick={() => router.push('/account')}>
                        <Settings className="size-4 mr-2" strokeWidth={1.75} />
                        Settings
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => router.push('/files')}>
                        <Files className="size-4 mr-2" strokeWidth={1.75} />
                        Files
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => router.push('/management')}>
                        <Gauge className="size-4 mr-2" strokeWidth={1.75} />
                        <span className="flex-1">Management</span>
                        {/* Decisions-needed badge (ticket 43212128): the open-decision
                            count rides the Management link too. */}
                        {pendingOwnerDecisions.length > 0 && (
                          <span className="ml-auto rounded-full bg-warn/90 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-send-ink dark:text-background">
                            {pendingOwnerDecisions.length}
                          </span>
                        )}
                      </DropdownMenuItem>
                    </>
                  )}
                  <DropdownMenuItem onClick={() => router.push('/help')}>
                    <LifeBuoy className="size-4 mr-2" strokeWidth={1.75} />
                    Help &amp; Docs
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => router.push('/privacy')}>
                    <Shield className="size-4 mr-2" strokeWidth={1.75} />
                    Privacy Policy
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => router.push('/terms')}>
                    <ScrollText className="size-4 mr-2" strokeWidth={1.75} />
                    Terms of Service
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => {
                      // Digby Kids: a child can't leave their account without the
                      // parent PIN — stops a kid from logging out into an adult account.
                      if (user?.isChild) { setKidLogoutPin(''); setKidLogoutOpen(true); return; }
                      performLogout();
                    }}
                  >
                    <LogOut className="size-4 mr-2" strokeWidth={1.75} />
                    Log out
                  </DropdownMenuItem>
                  <p className="px-2 pt-1.5 pb-1 text-[11px] text-ink-3">© {new Date().getFullYear()} Digby</p>
                </DropdownMenuContent>
              </DropdownMenu>

          </AppRail>
        )}

        {/* ── Guest sidebar (anonymous only, ticket 63bb607f) — the
                browser-local conversation rail, mirroring the authed gate
                structure (mobile backdrop + aside) on the same sidebarOpen
                state; no resize handle for guests. */}
        {!user && (
          <GuestSidebar
            open={sidebarOpen}
            onClose={() => setSidebarOpen(false)}
            sessions={guestSessions}
            activeId={activeGuestId}
            onSelect={selectGuestSession}
            onDelete={deleteGuestSession}
            onNewChat={startNewGuestChat}
          />
        )}

        {/* Main chat area + Canvas panel */}
        <div className="flex flex-1 overflow-hidden min-w-0">
        <div id="main" tabIndex={-1} className="flex flex-col flex-1 min-w-0 overflow-hidden outline-none">
        {(codeChatId || chatlessActive) ? (
          // Key includes the plain/coding flavor: an in-place conversion flips
          // codeChatPlain on the SAME chatId, and the view's load effect would
          // never re-fire without a remount (it keys off chatId) — the converted
          // chat would hang on the opening spinner.
          <CodeSessionView key={codeChatId ? `${codeChatId}:${codeChatPlain ? 'plain' : 'coding'}` : `chatless-${chatlessActive!.nonce}`} chatId={codeChatId} isKid={isKid} onRunningChange={handleCodeRunning}
            // 7acaa7ba: member view — a project member opening the owner's coding
            // session sees a read-only composer (server enforces CODING_OWNER_ONLY).
            viewerId={user?.id ?? null}
            initialMessage={codeInitialMessage ?? undefined}
            initialImages={codeInitialImages.length ? codeInitialImages : undefined}
            initialDisplayContent={codeInitialDisplay ?? undefined}
            onInitialMessageConsumed={handleCodeInitialConsumed}
            onTitleChange={handleCodeTitle}
            onChromeChange={setCodeChrome}
            settingsSection={settingsSection}
            // ONE page-owned right-panel state for every session kind (plain,
            // coding, chatless) — the ⋯-menu "Side panel" toggle and the canvas
            // auto-open both drive it; it persists across chat switches.
            panelOpen={panelOpen}
            onPanelOpenChange={setPanelOpen}
            pendingChatConfirmations={openChatPendingConfirmations}
            onResolvePendingConfirmation={handleResolvePendingAction}
            pendingOwnerQuestions={openChatOwnerQuestions}
            onAnswerOwnerQuestion={handleAnswerOwnerQuestion}
            onDismissOwnerQuestion={handleDismissOwnerQuestion}
            onOpenInbox={() => router.push('/management?tab=inbox')}
            onOpenChat={openChatById}
            header={headerNode}
            plain={(codeChatPlain || chatlessActive) ? {
              // C3: anonymous GUEST mode (limited features + sign-up CTAs —
              // owner directive) vs the signed-in createChat-failure FALLBACK
              // (full features, ephemeral).
              guest: chatlessActive?.guest ?? false,
              // Guest sessions (63bb607f): the conversation's client-minted
              // UUID — the view threads it into the chatId-less stream URL
              // (server: anonymous-only cm_session context key), the reopened
              // record's transcript seeds the mount, and every turn mirrors
              // back into the browser-local store. Undefined for authed /
              // fallback mounts.
              guestSessionId: chatlessActive?.guest ? (activeGuestId ?? undefined) : undefined,
              initialTranscript: chatlessActive?.guest && activeGuestId
                ? guestSessions.find(s => s.id === activeGuestId)?.messages
                : undefined,
              onTranscriptChange: chatlessActive?.guest && activeGuestId
                ? (msgs: CodingMessage[]) => handleGuestTranscript(activeGuestId, msgs)
                : undefined,
              // Guest title (2026-09-26): the server-generated title for the
              // chatId-less run retitles the browser-local record.
              onGuestTitle: chatlessActive?.guest && activeGuestId ? handleGuestTitle : undefined,
              // Ghost mode (2026-10-22): the OPEN conversation's flag + the ONE
              // composer toggle (integ/ghost-composer merged PR #1897's
              // signed-in toggle and feat/ghost-composer-toggle onto these two
              // props — no second prop pair, no second button).
              //  - Guests: the browser-local per-session flag (the view threads
              //    ghost=true on EVERY chatId-less send).
              //  - The signed-in createChat-failure fallback: the home toggle's
              //    ARMED posture, carried per send (no row exists to carry it);
              //    no toggle — the posture was chosen before the send.
              //  - Signed-in, own PLAIN chat with a known posture
              //    (ghostToggleTarget): the chat row's ghostMode, flipped via
              //    PUT /chats/:id like the side panel's switch. It rides that
              //    chat's send too, where the server ignores it (a row's
              //    STORED flag governs).
              ghost: chatlessActive?.guest
                ? guestGhost
                : chatlessActive?.ghost ? true : (ghostTarget?.kind === 'chat' ? ghostTarget.on : undefined),
              onToggleGhost: chatlessActive?.guest && activeGuestId
                ? toggleGuestGhost
                : ghostTarget?.kind === 'chat'
                  ? () => void toggleChatGhost(ghostTarget.chatId, ghostTarget.on)
                  : undefined,
              ghostSaving: chatGhostSaving,
              // Depth UX (2026-09-26; roster 2026-10-06 B-3): the wire mode + modeSource of a human send, the
              // research rung's quota (to the Dig-deeper chip) and the Dig-deeper switch — the pure seam
              // buildPlainDepthConfig (plain-session.ts): signed-in = Auto (Digby picks depth and models per
              // message); guests = the forced Ensemble; kids = their stored mode, untouched.
              ...buildPlainDepthConfig({
                pref: normalizePatienceMode(mode),
                guest: !!chatlessActive?.guest,
                isKid,
                deepResearchQuota,
              }),
              // A settled Dig-deeper tap / council send re-reads the quota so the
              // research chip greys in-session (audit 2026-09-26 routing-unify-2).
              onDepthRunSettled: user && !isKid ? () => { deepResearchApi.getQuota().then(setDeepResearchQuota).catch(() => {}); } : undefined,
              webSearch,
              attachOnLoad: codeChatId ? effectiveGeneratingIds.has(codeChatId) : false,
              // Shared-project author attribution (58ffcf86 → C2 port, ticket
              // 71b1fec6): the view tints + footnotes user rows stamped with a
              // DIFFERENT authorId than the signed-in viewer's.
              viewerId: user?.id ?? null,
              // Self-host setup hardening (2026-10-20): the transparency pill must not say
              // "searched the web" on an instance whose search tools answer "not configured".
              webSearchConfigured: !webSearchUnavailable(instanceSetup),
              onAnswerQuestion: (questionId: string, answer: string) => {
                if (!user) { toast.error('Sign in to answer questions.'); return; }
                if (!codeChatId) return; // chatless: ask-user never fires (the server blocks it chatless)
                void confirmationsApi.answerChatQuestion(codeChatId, questionId, answer)
                  .then((res) => {
                    // 992c8374: a swallowed success:false looked EXACTLY like a
                    // sent answer — the card cleared optimistically, the wait
                    // never resolved, and the next wake re-asked the question.
                    if (!res || res.success === false) {
                      toast.error(res?.error === 'unknown_or_expired'
                        ? 'That question had already closed — your answer did not land. If the card reappears, answer the new one.'
                        : res?.error || 'Could not send your answer');
                    }
                    void refreshPendingConfirmations();
                  })
                  .catch(() => toast.error('Could not send your answer'));
              },
              // Mirror the page's canvas event handling (send-stream path).
              // Digby Frontier inline canvas cards: the view pins each canvas
              // to the answer that produced it and opens it on click.
              canvases: chatlessActive?.guest ? undefined : canvases,
              onOpenCanvas: chatlessActive?.guest ? undefined : (id: string) => { setActiveCanvasId(id); setPanelOpen(true); },
              onCanvas: (data: any) => {
                const c = data?.data ?? data?.canvas ?? data;
                if (!c) return;
                const newId = c.id || crypto.randomUUID();
                setCanvases(prev => [...prev, {
                  id: newId,
                  title: c.title || 'Untitled',
                  type: (c.type || 'document') as CanvasItem['type'],
                  language: c.language || null,
                  content: c.content || '',
                  version: 1,
                  createdAt: new Date().toISOString(),
                }]);
                // File browser (59a4454e): a freshly streamed file opens INTO the
                // detail view — same as the legacy send-stream path.
                setActiveCanvasId(newId);
                setPanelOpen(true);
              },
              // iMessage confirm card (E5, 2026-09-25): the bridge forwards the
              // 'imessage-draft' event here — the dialog below owns Send/Cancel.
              onImessageDraft: (data: any) => {
                const d = data?.data ?? data;
                if (!d || typeof d.text !== 'string' || !d.text) return;
                setImsgDraft({
                  to: typeof d.to === 'string' ? d.to : '',
                  displayName: typeof d.displayName === 'string' ? d.displayName : '',
                  text: d.text,
                  resolved: d.resolved === true,
                  ...(typeof d.decisionId === 'string' && d.decisionId ? { decisionId: d.decisionId } : {}),
                });
              },
              // ── P2 increment 2 parity props ──
              isAdmin,
              // Plain attachments: the bar + upload state stay in this page;
              // the view renders the chips into its composer topContent slot,
              // routes paperclip/drop/paste gestures to onAttachFiles, and
              // snapshots+clears the bar via takeAttachments at send time.
              // Ticket 625773b5: guests get the SAME attachment plumbing — the
              // chatless guest send rides the open /stream route with uploadId
              // params exactly like a signed-in send, and the open /upload
              // route has always accepted anonymous callers.
              hasAttachments: attachments.length > 0,
              takeAttachments: () => {
                const s = attachments;
                if (s.length) setAttachments([]);
                return s.map(a => ({ uploadId: a.uploadId, filename: a.filename, type: a.type, localPreview: a.localPreview }));
              },
              attachmentsBar: attachments.length > 0 || attachmentRejections.length > 0 ? (
                <>
                  <AttachmentChips attachments={attachments} onRemove={(i) => setAttachments(prev => prev.filter((_, j) => j !== i))} />
                  {/* Ticket 33a742c1: a file that failed to stage stays visible
                      here until dismissed or sent — never a silent disappearance. */}
                  <AttachmentNotice rejections={attachmentRejections} onDismiss={() => setAttachmentRejections([])} />
                </>
              ) : undefined,
              onAttachFiles: (files: File[]) => { void processFiles(files); },
              // bg-ES handoff: the view opened its own SSE for this chat —
              // close any page-level pipe still held for it (agent attach pipe
              // or a backgrounded foreground stream): exactly one consumer.
              onStreamClaim: chatlessActive ? undefined : (cid: string) => {
                if (agentAttachEsRef.current) { agentAttachEsRef.current.close(); agentAttachEsRef.current = null; }
                const bg = bgEventSourcesRef.current.get(cid);
                if (bg) { bg.close(); bgEventSourcesRef.current.delete(cid); }
              },
              // ── C3 blocker 2 (ticket 71b1fec6, design D1) ──
              // The page-owned plain panel sections (built through the
              // workspace-sections registry above) mount INSIDE the view's
              // in-flow panel; open state is the page-owned panelOpen passed
              // top-level above (same state coding sessions use).
              panelSections: chatlessActive?.guest ? [] : chatlessActive ? pagePanelSectionsChatless : pagePanelSections,
            } : undefined} />
        ) : (
        <>
          {headerNode}
          {/* ── HOME (Digby Frontier, 2026-10-06) ── one scroll column: the
              hero (hat + serif greeting + meta line), the composer directly
              under it (home variant), then the briefing + schedule grid.
              C3: this branch is HOME-only — any send mounts the converged
              session view. min-h-0 is critical: a flex child won't shrink
              below its content height without it. */}
          <ScrollArea className="flex-1 min-h-0" style={{ overscrollBehaviorY: 'contain' }} viewportRef={chatViewportRef}>
            <div ref={chatContentRef} className="flex w-full flex-col pb-[max(1rem,env(safe-area-inset-bottom,0px),var(--app-overflow,0px))]">

            {/* ── Hero ── 46rem column, 13vh top, centred; dg-rise 520ms. */}
            <div className="dg-rise-hero mx-auto w-full max-w-(--measure-chat) px-6 pt-[13vh] pb-7 text-center">
              {user ? (
                (() => {
                  const hour = new Date().getHours();
                  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
                  const firstName = (user.firstName || '').trim();
                  const w = homeWeather;
                  // US users read °F; everyone else °C
                  const useF = w?.location?.country === 'United States';
                  const deg = (c?: number, f?: number) => useF ? `${f}°` : `${c}°`;
                  const locationLabel = w?.available && w.location
                    ? [w.location.name, w.location.region].filter(Boolean).join(', ')
                    : '';
                  const WeatherIcon = weatherIconFor(w?.current?.code, w?.current?.isDay ?? true);
                  return (
                    <>
                      <div className="flex items-center justify-center gap-3.5">
                        <BrandSpinner size={40} alt={branding.name} className="dg-float size-10 flex-shrink-0 select-none object-contain" />
                        <h1 className="m-0 font-serif text-[clamp(30px,7.5vw,40px)] font-normal leading-[1.1] tracking-[-0.015em] text-balance text-ink">
                          {greeting}{firstName ? `, ${firstName}` : ''}
                        </h1>
                      </div>
                      <div className="mt-3.5 flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 text-[13.5px] text-ink-3">
                        <span>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
                        {locationLabel && (
                          <>
                            <span className="opacity-50" aria-hidden>·</span>
                            <span className="flex items-center gap-[5px]"><MapPinIcon className="size-[13px]" strokeWidth={1.75} />{locationLabel}</span>
                          </>
                        )}
                        {w?.available && w.current && (
                          <>
                            <span className="opacity-50" aria-hidden>·</span>
                            <span
                              className="flex items-center gap-[5px]"
                              title={`Feels like ${useF ? `${Math.round(w.current.apparentC * 9 / 5 + 32)}°F` : `${w.current.apparentC}°C`} · Humidity ${w.current.humidity}% · Wind ${w.current.windKph} km/h`}
                            >
                              <WeatherIcon className="size-3.5" strokeWidth={1.75} aria-hidden />
                              {deg(w.current.tempC, w.current.tempF)} {w.current.description}
                            </span>
                            {w.today && (
                              <span className="tabular-nums">
                                H {useF ? `${w.today.maxF}°` : `${w.today.maxC}°`} L {useF ? `${w.today.minF}°` : `${w.today.minC}°`}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </>
                  );
                })()
              ) : (
                <>
                  <div className="flex items-center justify-center gap-3.5">
                    <BrandSpinner size={40} alt={branding.name} className="dg-float size-10 flex-shrink-0 select-none object-contain" />
                    <RotatingTagline />
                  </div>
                  {/* The home page's ONE h1 (2026-10-14 SEO pass): the rotating
                      tagline is decorative, so the page's subject is stated
                      once for search engines and screen readers. */}
                  <h1 className="sr-only">{branding.title}</h1>
                  <p className="mx-auto mt-3.5 max-w-md text-[13.5px] text-ink-3">
                    {branding.name} is an AI assistant that handles every task — writing, coding, planning, and answers. Hosted and built entirely in Canada.{' '}
                    <Link href="/about" className="underline decoration-line-2 underline-offset-[3px] hover:text-ink">Learn more</Link>
                  </p>
                </>
              )}
            </div>

            {/* ── Composer (home variant) — directly under the hero ── */}
            <div className="mx-auto w-full max-w-(--measure-chat) px-4 sm:px-6 space-y-2">
              {/* Attachment preview bar. Ticket 625773b5 (owner report): guests
                  get the SAME attach surface as signed-in users — the C3
                  "no attachments for guests" gate is lifted (the backend's open
                  /upload route has always accepted anonymous callers:
                  optionalAuthenticate stamps ownerUserId null). */}
              {attachments.length > 0 && (
                <AttachmentChips attachments={attachments} onRemove={(i) => setAttachments(prev => prev.filter((_, j) => j !== i))} />
              )}
              {/* Ticket 33a742c1: staging failures stay visible inline. */}
              <AttachmentNotice rejections={attachmentRejections} onDismiss={() => setAttachmentRejections([])} />
              <ChatComposer
                variant="chat"
                size="home"
                composerRef={composerRef}
                textareaRef={textareaRef}
                onSubmit={submitFromComposer}
                onEmptyChange={handleComposerEmptyChange}
                onPaste={handlePaste}
                canSubmit={hasText || attachments.length > 0}
                isStreaming={false}
                onStop={() => {}}
                placeholder={isRecording ? '🎤 Listening… speak now' : dragOver ? '📎 Drop files here…' : 'How can I help today?'}
                dragOver={dragOver}
                dragHandlers={{
                  onDragOver: e => { e.preventDefault(); setDragOver(true); },
                  onDragEnter: e => { e.preventDefault(); setDragOver(true); },
                  onDragLeave: () => setDragOver(false),
                  onDrop: handleDrop,
                }}
                hiddenFileInput={(
                  /* Visually-hidden file input — rendered (NOT display:none): iOS
                      Safari/PWA is flaky clicking display:none inputs and can paint
                      the native "Choose File" UI over the composer (owner report);
                      1px + opacity-0 keeps the gesture chain solid and invisible. */
                  <input ref={fileInputRef} type="file" multiple
                    aria-hidden="true" tabIndex={-1}
                    className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
                    accept="image/*,audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac,.pdf,.docx,.xlsx,.xls,.txt,.csv,.json,.xml,.md,.markdown,.log,.out,.diff,.patch,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/plain,text/csv,text/markdown,application/json,text/xml,application/xml"
                    onChange={handleFileSelect} />
                )}
                topContent={
                  /* Folder breadcrumb — small-text path shown whenever chatting inside a
                      folder (2026-08-14: the folder chip + leading icon were dropped as
                      redundant; the path alone carries the context) */
                  currentProjectId && currentProjectName && getFolderPath(currentProjectId).length > 0 ? (
                    <div className="flex items-center gap-1 px-3 pb-2 text-[11.5px] text-ink-3 overflow-hidden">
                      {getFolderPath(currentProjectId).map((p, i, arr) => (
                        <span key={p.id} className="flex items-center gap-1 min-w-0">
                          {i > 0 && <ChevronRight className="size-2.5 flex-shrink-0 opacity-60" />}
                          <span className={cn('truncate', i === arr.length - 1 && 'text-ink-2 font-medium')}>{p.name}</span>
                        </span>
                      ))}
                    </div>
                  ) : undefined
                }
                footerNote={charCount >= NEAR_LIMIT_CHAT_CHARS ? (
                  /* Live counter once the draft nears the 8,000-char cap
                     (ticket 4b7a32b1) — red + explicit once it is over; the
                     pre-send gate refuses the send with the same length named. */
                  <p
                    aria-live="polite"
                    className={cn(
                      'mt-1 text-right text-[11px] tabular-nums',
                      charCount > MAX_CHAT_MESSAGE_CHARS ? 'text-destructive font-medium' : 'text-muted-foreground',
                    )}
                  >
                    {charCount.toLocaleString()} / {MAX_CHAT_MESSAGE_CHARS.toLocaleString()} characters
                    {charCount > MAX_CHAT_MESSAGE_CHARS ? ' — too long to send' : ''}
                  </p>
                ) : undefined}
                leftActions={<>
                  {/* Add files — a 34px outlined circle (Digby Frontier; was the
                      Paperclip). Ticket 625773b5: rendered for guests too — the
                      C3 "no attachments for guests" gate is lifted (owner
                      report); uploads go to the open /upload route. */}
                  <button
                    type="button"
                    className={cn(COMPOSER_ATTACH_BTN, attachments.length > 0 && 'text-ink border-line-2')}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    title="Add files"
                    aria-label="Attach files"
                  >
                    {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-[17px]" strokeWidth={1.75} />}
                  </button>
                  {/* Ghost composer toggle (2026-10-22) — SIGNED-IN, home: ARMS
                      ghost for the chat the next send creates (createChatWithGhost
                      puts ghostMode:true on POST /chats), so the first message is
                      already private. The pressed state is the indicator. Guests
                      get theirs in the guest view; kids and
                      NEXT_PUBLIC_GHOST_COMPOSER_TOGGLE_DISABLED=1 get none. */}
                  {ghostTarget?.kind === 'new' && (
                    <GhostComposerToggle armsNewChat on={newChatGhost} onToggle={() => setNewChatGhost(!newChatGhostRef.current)} />
                  )}
                </>}
                rightActions={<>
                  {/* Mic — voice input, a 34px ghost circle. Rendered in EVERY
                      host, the desktop shell included (2026-10-20: one UI for
                      chats and coding sessions) — in the shell the tap goes to
                      the native recorder over the dictation bridge (00504a77
                      keeps the web recorder itself off there). */}
                  <button
                    type="button"
                    className={cn(
                      COMPOSER_TOOL_BTN,
                      isRecording && 'text-destructive bg-destructive/10 dark:bg-destructive/15 animate-pulse',
                    )}
                    onClick={handleMicClick}
                    disabled={isTranscribing}
                    title={isTranscribing ? 'Transcribing…' : isRecording ? 'Stop recording' : 'Voice input'}
                    aria-label={isTranscribing ? 'Transcribing' : isRecording ? 'Stop recording' : 'Voice input'}
                  >
                    {isTranscribing
                      ? <Loader2 className="size-4 animate-spin" />
                      : isRecording
                      ? <MicOff className="size-[17px]" strokeWidth={1.75} />
                      : <Mic className="size-[17px]" strokeWidth={1.75} />
                    }
                  </button>
                </>}
              />
              {/* Personalized starters — quiet pills under the composer; a tap
                  prefills the composer. */}
              {user && suggestedQuestions.length > 0 && (
                <div className="flex flex-wrap justify-center gap-2 pt-3">
                  {suggestedQuestions.map((suggestion, si) => (
                    <button
                      key={`${si}-${suggestion}`}
                      onClick={() => { setInput(suggestion); requestAnimationFrame(() => textareaRef.current?.focus()); }}
                      className="rounded-full border border-line px-3.5 py-1.5 text-[13px] text-ink-2 transition-colors duration-150 hover:border-line-2 hover:bg-hover hover:text-ink"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
              {!user && (
                /* Guest starters (2026-10-16 site review): the same quiet pills
                   signed-in users get — a tap prefills the composer, never sends. */
                <div className="flex flex-wrap justify-center gap-2 pt-3">
                  {GUEST_STARTERS.map((starter) => (
                    <button
                      key={starter}
                      onClick={() => { setInput(starter); requestAnimationFrame(() => textareaRef.current?.focus()); }}
                      className="rounded-full border border-line px-3.5 py-1.5 text-[13px] text-ink-2 transition-colors duration-150 hover:border-line-2 hover:bg-hover hover:text-ink"
                    >
                      {starter}
                    </button>
                  ))}
                </div>
              )}
              {!user && (
                <p className="pt-3 text-center text-[12.5px] text-ink-3">
                  <Lightbulb className="inline size-3.5 -mt-0.5 mr-1" strokeWidth={1.75} />Sign in to save your chat history and build your AI memory
                </p>
              )}
            </div>

            {/* ── Briefing + schedule ── max 52rem, auto-fit 300px columns,
                gap 36; dg-rise 620ms (+80ms). No bordered containers or
                category dots (Digby Frontier). */}
            {user && !currentChatId && (
              <div className="dg-rise-late mx-auto grid w-full max-w-[52rem] gap-9 px-4 pt-11 pb-16 text-left sm:px-6 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">

              {/* ── Your daily briefing ── */}
              <section aria-label="Your daily briefing" className="min-w-0">
                <div className="flex items-center gap-2 px-2.5 pb-2.5 text-ink-2">
                  <Newspaper className="size-[15px] flex-shrink-0" strokeWidth={1.75} />
                  <span className="flex-1 text-[13px] font-medium">Your daily briefing</span>
                  {!newsLoading && newsHeadlines.length > 0 && readNewsIndices.size > 0 && (
                    <span className="text-[12px] text-ink-3 tabular-nums">
                      {readNewsIndices.size}/{newsHeadlines.length} read
                    </span>
                  )}
                  {expandedNewsIndices.size >= 2 && (
                    <button
                      onClick={() => setExpandedNewsIndices(new Set())}
                      className="text-[12px] text-ink-3 hover:text-ink transition-colors"
                      title="Collapse all (Esc)"
                    >
                      Collapse all
                    </button>
                  )}
                  {expandedNewsIndices.size === 0 && newsHeadlines.length >= 2 && (
                    <button
                      onClick={() => setExpandedNewsIndices(new Set(newsHeadlines.slice(0, newsVisibleCount).map((_, idx) => idx)))}
                      className="text-[12px] text-ink-3 hover:text-ink transition-colors"
                    >
                      Expand all
                    </button>
                  )}
                  {!newsLoading && (
                    <button
                      onClick={() => fetchNewsWithRetry(0)}
                      className="flex size-[26px] items-center justify-center rounded-[7px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                      title="Refresh news"
                      aria-label="Refresh news"
                    >
                      <RefreshCw className="size-[13px]" strokeWidth={1.75} />
                    </button>
                  )}
                </div>
                {newsLoading ? (
                  <div className="flex items-center gap-2 px-2.5 py-6 text-[13.5px] text-ink-3">
                    <Loader2 className="size-4 animate-spin" />
                    Curating your news…
                  </div>
                ) : newsHeadlines.length === 0 ? (
                  <div className="px-2.5 py-4 text-[13.5px] text-ink-3">
                    {newsUnconfigured ? (
                      <p className="flex items-center gap-2" data-testid="news-unconfigured">
                        <Clock className="size-3.5" />
                        {newsUnconfiguredReason === 'formatter'
                          ? 'Personalized news needs a background summarizer model, which isn\u2019t assigned on this Digby instance (an admin can set one under Account \u2192 Admin \u2192 Endpoints \u2192 Model roles \u2192 Utility).'
                          : "Headlines need live web search, which isn\u2019t set up on this Digby instance."}
                      </p>
                    ) : newsDegraded ? (
                      <>
                        <p className="flex items-center gap-2"><Clock className="size-3.5" />Personalized news is temporarily unavailable — we&apos;ll retry automatically.</p>
                        <p className="mt-1 text-[12px]">Retrying every minute in the background</p>
                      </>
                    ) : (
                      <>
                        <p className="flex items-center gap-2"><Loader2 className="size-3.5 animate-spin" />Your news is being prepared — it&apos;ll appear shortly…</p>
                        <p className="mt-1 text-[12px]">Checking every few seconds</p>
                      </>
                    )}
                    <button
                      onClick={() => fetchNewsWithRetry(0)}
                      className="mt-3 flex items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
                    >
                      <RefreshCw className="size-3" />
                      Refresh now
                    </button>
                  </div>
                ) : (
                  <div>
                    {newsHeadlines.slice(0, newsVisibleCount).map((item, i) => {
                      const isExpanded = expandedNewsIndices.has(i);
                      const isRead = readNewsIndices.has(i);
                      const categoryLabel = item.category === 'local' ? 'Local' : item.category === 'us' ? 'Trending' : 'For you';
                      return (
                        <div
                          key={i}
                          ref={(el) => { if (el) newsCardRefs.current.set(i, el); else newsCardRefs.current.delete(i); }}
                          className={cn('rounded-xl transition-colors duration-150', isExpanded ? 'bg-hover/60' : 'hover:bg-hover')}
                        >
                          {/* Row — always visible, toggles the story open/closed */}
                          <button
                            onClick={() => handleNewsExpand(i)}
                            className="flex w-full items-baseline gap-3 p-2.5 text-left"
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'}: ${item.headline}`}
                            aria-expanded={isExpanded}
                          >
                            <span className={cn(
                              'min-w-0 flex-1 text-[14px] leading-[1.45] text-pretty',
                              isRead && !isExpanded ? 'text-ink-2' : 'text-ink',
                              isExpanded && 'font-medium',
                            )}>
                              {item.headline}
                            </span>
                            <span className="flex-shrink-0 text-[11.5px] text-ink-3">{categoryLabel}</span>
                          </button>
                          {/* Expanded story */}
                          {isExpanded && (
                            <div className="dg-rise-fast px-2.5 pb-3">
                              <p className="text-[15px] leading-[1.6] text-ink-2 whitespace-pre-wrap">{item.summary}</p>
                              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                                <button
                                  onClick={() => handleNewsFollowUp(
                                    buildNewsAskContext(item.chatPrompt || 'Tell me more about this story', item),
                                    `📰 Tell me more about: ${item.headline}`
                                  )}
                                  className="flex items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
                                >
                                  Ask {branding.name} about this
                                  <ArrowRight className="size-[13px]" />
                                </button>
                                {([
                                  ['Implications', `What are the implications of this: ${item.headline}\n\nHere's what I read: ${item.summary}`, `📰 What are the implications of: ${item.headline}`],
                                  ['How does this affect me?', `How does this affect me personally? ${item.headline}\n\nContext: ${item.summary}`, `📰 How does this affect me? ${item.headline}`],
                                  ['Explain it simply', `Explain this in simple terms that anyone can understand: ${item.headline}\n\nFull story: ${item.summary}`, `📰 Explain simply: ${item.headline}`],
                                ] as const).map(([label, prompt, display]) => (
                                  <button
                                    key={label}
                                    onClick={() => handleNewsFollowUp(prompt, display)}
                                    className="rounded-full border border-line px-3 py-1.5 text-[12.5px] text-ink-3 transition-colors hover:border-line-2 hover:bg-raised hover:text-ink"
                                  >
                                    {label}
                                  </button>
                                ))}
                                <span className="flex-1" />
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(`${item.headline}\n\n${item.summary}`);
                                    setCopiedNewsIndex(i);
                                    setTimeout(() => setCopiedNewsIndex(null), 2000);
                                    toast.success('Story copied to clipboard');
                                  }}
                                  className="flex size-[28px] items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                                  title="Copy story"
                                  aria-label={`Copy: ${item.headline}`}
                                >
                                  {copiedNewsIndex === i ? <Check className="size-3.5" /> : <Copy className="size-3.5" strokeWidth={1.75} />}
                                </button>
                                <button
                                  onClick={async () => {
                                    const shareText = `${item.headline}\n\n${item.summary}`;
                                    if (typeof navigator.share === 'function') {
                                      try { await navigator.share({ title: item.headline, text: shareText }); } catch { /* cancelled */ }
                                    } else {
                                      navigator.clipboard.writeText(shareText);
                                      toast.success('Story copied for sharing');
                                    }
                                  }}
                                  className="flex size-[28px] items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                                  title="Share story"
                                  aria-label={`Share: ${item.headline}`}
                                >
                                  <Share className="size-3.5" strokeWidth={1.75} />
                                </button>
                              </div>
                              {/* Ask anything about this story */}
                              <form
                                className="mt-2.5 flex gap-1.5"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  const formData = new FormData(e.currentTarget);
                                  const q = (formData.get('newsQ') as string || '').trim();
                                  if (!q) return;
                                  handleNewsFollowUp(
                                    buildNewsAskContext(q, item),
                                    `📰 ${q}`
                                  );
                                }}
                              >
                                <input
                                  name="newsQ"
                                  type="text"
                                  placeholder="Or ask your own question about this story…"
                                  className="h-8 flex-1 rounded-full border border-line bg-raised px-3 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-line-2"
                                  autoComplete="off"
                                />
                                <button
                                  type="submit"
                                  className="flex size-8 flex-shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-hover hover:text-ink"
                                  title="Ask about this story"
                                  aria-label="Ask about this story"
                                >
                                  <ArrowUp className="size-3.5" strokeWidth={2} />
                                </button>
                              </form>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Load more — quiet text action */}
                {!newsLoading && newsHeadlines.length > newsVisibleCount && (
                  <button
                    onClick={() => setNewsVisibleCount(prev => Math.min(prev + 6, newsHeadlines.length))}
                    className="mt-1 flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                  >
                    <ChevronDown className="size-3.5" />
                    Show {Math.min(6, newsHeadlines.length - newsVisibleCount)} more
                  </button>
                )}
              </section>

              {/* ── Today (calendar) ── */}
              <section aria-label="Today" className="min-w-0">
              {!calendarConnected && !calendarLoading && (
                <>
                  <div className="flex items-center gap-2 px-2.5 pb-2.5 text-ink-2">
                    <CalendarDays className="size-[15px] flex-shrink-0" strokeWidth={1.75} />
                    <span className="flex-1 text-[13px] font-medium">Today</span>
                  </div>
                  {/* Connect your calendar — same row styling, no dashed border / gradient */}
                  <button
                    onClick={() => {
                      const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
                      if (!token) return;
                      const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
                      window.location.href = `${apiBase}/crossmodel/google/auth?token=${token}`;
                    }}
                    className="group flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition-colors duration-150 hover:bg-hover"
                  >
                    <span className="flex size-10 flex-shrink-0 items-center justify-center rounded-[10px] bg-hover text-ink-2">
                      <CalendarDays className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] text-ink">Connect your calendar</span>
                      <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-3">See today&apos;s schedule and get prep for every meeting.</span>
                    </span>
                    <ArrowRight className="size-4 flex-shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
                  </button>
                  {/* macOS half (2026-11-06): when a paired Mac is the reason
                      there is nothing to show, say WHY — this is the state the
                      owner was stuck in ("calendar sync isn't working"). A Mac
                      that was never granted Calendar access must never render
                      as an empty/free day. */}
                  {calendarApple && calendarApple.state !== 'ok' && (
                    <div className="px-2.5 pb-2.5 text-[12.5px] leading-snug text-ink-3" data-testid={`calendar-apple-${calendarApple.state}`}>
                      {appleCalendarNotice(calendarApple)}
                    </div>
                  )}
                </>
              )}

              {/* Connected, loaded, NOTHING today — or the read failed (owner
                  2026-10-21: "where did the calendar view go?"): the card used
                  to render nothing in both states, which read as the calendar
                  having been removed by the UI update. Header + an honest line. */}
              {calendarConnected && !calendarLoading && calendarEvents.length === 0 && (
                <>
                  <div className="flex items-center gap-2 px-2.5 pb-2.5 text-ink-2">
                    <CalendarDays className="size-[15px] flex-shrink-0" strokeWidth={1.75} />
                    <span className="flex-1 text-[13px] font-medium">Today</span>
                  </div>
                  <div className="flex items-center gap-2 px-2.5 py-3 text-[13.5px] text-ink-3" data-testid={calendarError ? `calendar-error-${calendarError}` : 'calendar-empty'}>
                    {calendarError === 'reconnect' ? (
                      <>
                        <span className="flex-1">Google needs to be reconnected to read your calendar.</span>
                        <button type="button" onClick={() => router.push('/account?tab=integrations')} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-hover hover:border-line-2 transition-colors">Reconnect</button>
                      </>
                    ) : calendarError ? (
                      <>
                        <span className="flex-1">Couldn&apos;t load your calendar right now.</span>
                        <button type="button" onClick={loadCalendar} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 hover:bg-hover hover:border-line-2 transition-colors">Retry</button>
                      </>
                    ) : calendarApple && calendarApple.state !== 'ok' ? (
                      // A free day on Google is NOT a free day overall when the
                      // Mac half could not be read — say so (2026-11-06).
                      <span data-testid={`calendar-apple-${calendarApple.state}`}>{appleCalendarNotice(calendarApple)}</span>
                    ) : (
                      <span>Nothing on your calendar today.</span>
                    )}
                  </div>
                </>
              )}

              {calendarConnected && (calendarEvents.length > 0 || calendarLoading) && (() => {
                // Helper: determine if a calendar event is in the past using epoch ms from backend
                const isEventPast = (ev: CalendarEvent): boolean => {
                  // Prefer epoch values from backend (reliable server-side parsing)
                  const epoch = ev.endEpoch || ev.startEpoch;
                  if (epoch && epoch > 0) return epoch < Date.now();
                  // Fallback: parse raw date strings for backward compat
                  const raw = ev.endRaw || ev.startRaw;
                  if (!raw) return false;
                  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
                    return raw.trim() < new Date().toLocaleDateString('en-CA');
                  }
                  const cleaned = raw.replace(/\s+[A-Z]{2,5}$/, '').trim();
                  const parsed = new Date(cleaned);
                  if (!isNaN(parsed.getTime())) return parsed.getTime() < Date.now();
                  return false;
                };
                const pastCount = calendarEvents.filter(e => isEventPast(e)).length;
                const upcomingCount = calendarEvents.length - pastCount;
                // Find the index where past events end and upcoming begin (for "now" divider)
                let nowDividerAfterIndex = -1;
                for (let idx = 0; idx < calendarEvents.length; idx++) {
                  if (isEventPast(calendarEvents[idx])) nowDividerAfterIndex = idx;
                }
                const nowLabel = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
                return (
                <>
                  <div className="flex items-center gap-2 px-2.5 pb-2.5 text-ink-2">
                    <CalendarDays className="size-[15px] flex-shrink-0" strokeWidth={1.75} />
                    <span className="flex-1 text-[13px] font-medium">Today</span>
                    {!calendarLoading && calendarEvents.length > 0 && (
                      <span className="text-[12px] text-ink-3 tabular-nums">
                        {pastCount > 0 && upcomingCount > 0
                          ? `${pastCount} done · ${upcomingCount} upcoming`
                          : pastCount > 0
                            ? `${pastCount} done`
                            : `${calendarEvents.length} event${calendarEvents.length !== 1 ? 's' : ''}`}
                      </span>
                    )}
                  </div>
                  {calendarLoading ? (
                    <div className="flex items-center gap-2 px-2.5 py-6 text-[13.5px] text-ink-3">
                      <Loader2 className="size-4 animate-spin" />
                      Loading your schedule…
                    </div>
                  ) : (
                    <div>
                      {calendarEvents.map((event, i) => {
                        const timeDisplay = event.startTime ? (
                          event.endTime ? `${event.startTime} – ${event.endTime}` : event.startTime
                        ) : 'All day';
                        const past = isEventPast(event);
                        const prompts = event.aiPrompts || (event.aiPrompt ? [event.aiPrompt] : []);
                        // "Now" divider between the last past event and the first upcoming one
                        const showNowDivider = nowDividerAfterIndex >= 0 && i === nowDividerAfterIndex + 1 && !past && upcomingCount > 0;
                        return (
                          <div key={i}>
                            {showNowDivider && (
                              <div className="flex items-center gap-2 px-2.5 py-1" aria-label="Current time">
                                <span className="size-1.5 flex-shrink-0 rounded-full bg-warn" />
                                <span className="text-[11.5px] font-medium text-ink-2 tabular-nums">Now · {nowLabel}</span>
                                <span className="h-px flex-1 bg-line" />
                              </div>
                            )}
                            <div className={cn('grid grid-cols-[84px_minmax(0,1fr)] gap-3 rounded-xl p-2.5 transition-colors duration-150 hover:bg-hover', past && 'opacity-50')}>
                              <span className="text-[12.5px] leading-[1.55] text-ink-3 tabular-nums">{timeDisplay}</span>
                              <div className="min-w-0">
                                <div className={cn('text-[14px] leading-[1.45] text-ink', past && 'line-through decoration-line-2')}>
                                  {event.title}
                                </div>
                                {(event.location || event.account || event.source === 'apple') && (
                                  <div className="mt-0.5 flex items-center gap-1.5 truncate text-[12.5px] text-ink-3">
                                    {event.location && <span className="truncate">{event.location}</span>}
                                    {event.location && (event.account || event.source === 'apple') && <span aria-hidden>·</span>}
                                    {event.account && <span className="truncate">{event.account}</span>}
                                    {/* Source label (2026-11-06): the card now
                                        merges Apple + Google, so a row says which
                                        calendar it came from. */}
                                    {event.source === 'apple' && (
                                      <span className="flex-shrink-0 rounded-full border border-line px-1.5 py-px text-[10.5px] uppercase tracking-wide text-ink-3" title={`From your Mac${calendarApple?.device ? ` (${calendarApple.device})` : ''}`}>Mac</span>
                                    )}
                                  </div>
                                )}
                                {/* Prep prompts — pills; a tap prefills the composer. */}
                                {!past && prompts.length > 0 && (
                                  <div className="mt-2 flex flex-wrap gap-1.5">
                                    {prompts.slice(0, 2).map((prompt, pi) => (
                                      <button
                                        key={pi}
                                        onClick={() => { setInput(prompt); requestAnimationFrame(() => textareaRef.current?.focus()); }}
                                        className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:border-line-2 hover:bg-raised"
                                        title={prompt}
                                      >
                                        {prompt.length > 44 ? prompt.slice(0, 41) + '…' : prompt}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
                );
              })()}
              </section>
              </div>
            )}

            </div>
          </ScrollArea>
        </>
        )}
        </div>{/* /main chat area */}


        </div>{/* /chat + canvas inner row */}
      </div>{/* /body flex row */}

      {/* ── Footer for logged-out users — phones too (2026-10-16 site review:
          below md the home had no visible way into the public site but the
          "Learn more" link; the phone row keeps the shortest set). ── */}
      {!user && (
        <footer
          className="flex flex-shrink-0 flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t bg-background/80 px-4 pt-2 text-[11px] text-muted-foreground/70 backdrop-blur-sm max-md:[&>.md-only]:hidden"
          style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <span className="md-only">© {new Date().getFullYear()} Digby</span>
          <span className="md-only text-muted-foreground/30">·</span>
          {/* Public-site links (2026-10-14 SEO pass): the chat home links into
              the site, and every site page links back here. */}
          {([['/about', 'About', true], ['/features', 'Features', true], ['/private-ai', 'Private AI', false], ['/sovereign-ai', 'Sovereign AI', false], ['/learn', 'Learn', true], ['/faq', 'FAQ', false]] as const).map(([href, label, phone]) => (
            <Fragment key={href}>
              <Link href={href} className={cn('py-1.5 hover:text-foreground transition-colors md:py-0', !phone && 'md-only')}>{label}</Link>
              <span className={cn('text-muted-foreground/30', !phone && 'md-only')}>·</span>
            </Fragment>
          ))}
          <Link href="/terms" className="py-1.5 hover:text-foreground transition-colors md:py-0">Terms<span className="max-md:hidden"> of Service</span></Link>
          <span className="text-muted-foreground/30">·</span>
          <Link href="/privacy" className="py-1.5 hover:text-foreground transition-colors md:py-0">Privacy<span className="max-md:hidden"> Policy</span></Link>
          <span className="md-only text-muted-foreground/30">·</span>
          <a href="mailto:digby@digby.ai" className="md-only hover:text-foreground transition-colors">digby@digby.ai</a>
        </footer>
      )}

      {/* ── Delete Chat Confirmation ── */}
      <AlertDialog open={!!deletingChatId} onOpenChange={(open) => !open && setDeletingChatId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the conversation and all its messages. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingChatId && deleteChat(deletingChatId)}
              className="bg-destructive hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Memory Dialog ── */}
      <Dialog open={showMemoryPanel} onOpenChange={setShowMemoryPanel}>
        <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="size-4 text-ink-3" />
              AI Memory
            </DialogTitle>
            <DialogDescription>
              Facts the AI remembers about you across all conversations.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-3 py-1 min-h-0">
            {/* Existing facts */}
            {factEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No memory facts yet. They're extracted automatically as you chat.
              </p>
            ) : (
              <div className="space-y-2">
                {factEntries.map(([key, value]) => (
                  <div key={key} className="rounded-lg border bg-muted/30 px-3 py-2.5">
                    {editingKey === key ? (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground capitalize">{key}</p>
                        <Textarea
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          className="text-sm min-h-[60px]"
                          autoFocus
                        />
                        <div className="flex gap-2">
                          <Button size="sm" className="h-7 text-xs" onClick={() => handleUpdateFact(key)}>
                            <Check className="size-3 mr-1" />Save
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingKey(null)}>
                            <X className="size-3 mr-1" />Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-[12px] font-medium text-ink-3 capitalize">{key}</p>
                          <p className="text-sm mt-0.5 leading-snug whitespace-pre-wrap">
                            {typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value ?? '')}
                          </p>
                        </div>
                        <div className="flex gap-1 flex-shrink-0">
                          <button
                            onClick={() => { setEditingKey(key); setEditingValue(value); }}
                            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                            title="Edit"
                          >
                            <Pencil className="size-3" />
                          </button>
                          <button
                            onClick={() => handleDeleteFact(key)}
                            className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Add new fact */}
            <div className="rounded-lg border border-dashed p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Add a fact manually</p>
              <Input
                placeholder="Key (e.g. name, location, role)"
                value={newFactKey}
                onChange={(e) => setNewFactKey(e.target.value)}
                className="h-8 text-sm"
              />
              <Textarea
                placeholder="Value"
                value={newFactValue}
                onChange={(e) => setNewFactValue(e.target.value)}
                className="text-sm min-h-[60px]"
              />
              <Button
                size="sm"
                className="h-8 text-xs w-full"
                onClick={handleSaveFact}
                disabled={!newFactKey.trim() || !newFactValue.trim()}
              >
                <Plus className="size-3.5 mr-1" />
                Add Fact
              </Button>
            </div>
          </div>

          {/* Footer: clear all */}
          {factEntries.length > 0 && (
            <div className="border-t pt-3 mt-1">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full h-8 text-xs text-destructive hover:text-destructive border-destructive/40 hover:border-destructive">
                    <Trash2 className="size-3.5 mr-1.5" />
                    Clear All Memory
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear all memory?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete all {factEntries.length} memory facts. The AI will no longer remember anything about you until new facts are extracted.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleClearMemory} className="bg-destructive hover:bg-destructive/90">
                      Clear All
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {/* ── iMessage: confirm before sending ── */}
      <Dialog open={!!imsgDraft} onOpenChange={(o) => { if (!o && !imsgSending) declineImsgDraft(imsgDraft); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send this iMessage?</DialogTitle>
            <DialogDescription>
              Nothing is sent until you tap Send. It goes out from your paired Mac.
            </DialogDescription>
          </DialogHeader>
          {imsgDraft && (
            <div className="space-y-3 py-1">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">To</label>
                <Input
                  value={imsgDraft.to || imsgDraft.displayName || ''}
                  onChange={(e) => setImsgDraft({ ...imsgDraft, to: e.target.value })}
                  placeholder="Phone or email (e.g. +15551234567)"
                  className="h-9 text-sm"
                />
                {!imsgDraft.resolved && (
                  <p className="text-[11px] text-warn-ink">
                    Couldn’t match a contact automatically — double-check the phone/email above.
                  </p>
                )}
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Message</label>
                <textarea
                  value={imsgDraft.text}
                  onChange={(e) => setImsgDraft({ ...imsgDraft, text: e.target.value })}
                  rows={3}
                  className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring resize-y"
                />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="outline" size="sm" disabled={imsgSending} onClick={() => declineImsgDraft(imsgDraft)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={imsgSending}
                  onClick={async () => {
                    const to = (imsgDraft.to || imsgDraft.displayName || '').trim();
                    const text = imsgDraft.text.trim();
                    if (!to || !text) { toast.error('Add a recipient and a message'); return; }
                    setImsgSending(true);
                    try {
                      await imessageApi.send(to, text, undefined, imsgDraft.decisionId ? { decisionId: imsgDraft.decisionId } : undefined);
                      toast.success(<span className="inline-flex items-center gap-1.5">Message sent <Send className="size-3.5" /></span>);
                      setImsgDraft(null);
                    } catch (e: any) {
                      toast.error(e?.response?.data?.error || 'Failed to send message');
                    } finally {
                      setImsgSending(false);
                    }
                  }}
                >
                  {imsgSending ? 'Sending…' : 'Send'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── New Folder Dialog ── */}
      <Dialog open={showNewProjectDialog} onOpenChange={setShowNewProjectDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderPlus className="size-4 text-ink-3" />
              New Folder
            </DialogTitle>
            <DialogDescription>
              Organize chats and add knowledge for a specific topic.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* Emoji picker */}
            <div className="space-y-2">
              {/* Current selection + free-type input */}
              <div className="flex items-center gap-2">
                <span className="text-3xl size-10 flex items-center justify-center rounded-lg border bg-muted/40 flex-shrink-0">{newProjectEmoji}</span>
                <input
                  type="text"
                  value={newProjectEmoji}
                  onChange={e => {
                    // Take only the first character cluster (first emoji/char)
                    const val = [...e.target.value].slice(-1).join('');
                    if (val) setNewProjectEmoji(val);
                  }}
                  placeholder="Type any emoji…"
                  className="flex-1 h-9 rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-line-2"
                />
              </div>
              {/* Preset grid */}
              <div className="flex gap-1.5 flex-wrap">
                {['📁', '🚀', '💡', '🔬', '📝', '🎯', '💼', '🌐', '⚡', '🏠', '🎨', '🎓', '🏗️', '🧪', '📊', '🛠️', '🎵', '📱', '🌍', '🤖', '💰', '🏥', '📚', '✈️', '🍽️'].map((e) => (
                  <button
                    key={e}
                    onClick={() => setNewProjectEmoji(e)}
                    className={cn(
                      'text-lg rounded-md p-1 transition-colors hover:bg-muted',
                      newProjectEmoji === e && 'bg-active ring-1 ring-line-2'
                    )}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Folder name</Label>
              <Input
                autoFocus
                placeholder="e.g. Marketing Research"
                value={newProjectName}
                onChange={(e) => setNewProjectName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateProject();
                  if (e.key === 'Escape') setShowNewProjectDialog(false);
                }}
                className="h-9"
              />
            </div>
            {/* Parent folder picker — root by default; folders at the depth cap can't take children */}
            {flatFolders.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs">Parent folder</Label>
                <select
                  value={newProjectParentId}
                  onChange={(e) => setNewProjectParentId(e.target.value)}
                  className="w-full h-9 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">Top level (no parent)</option>
                  {flatFolders.map((n) => (
                    <option key={n.id} value={n.id} disabled={n.treeDepth >= MAX_FOLDER_DEPTH}>
                      {'\u00A0\u00A0'.repeat(n.treeDepth)}{n.emoji ? `${n.emoji} ` : ''}{n.name}{n.treeDepth >= MAX_FOLDER_DEPTH ? ' (max depth)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setShowNewProjectDialog(false)}
            >
              Cancel
            </Button>
            <Button
              className="flex-1 bg-send text-send-ink hover:opacity-90 border-0"
              onClick={handleCreateProject}
              disabled={!newProjectName.trim() || creatingProject}
            >
              {creatingProject ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
              Create
            </Button>
          </div>
          <button
            onClick={() => { setShowNewProjectDialog(false); setShowImportProjectDialog(true); }}
            className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground transition-colors pt-1"
          >
            Building software? Import a <span className="text-ink-3 font-medium">code folder</span> instead (GitHub · git URL · blank) →
          </button>
        </DialogContent>
      </Dialog>

      {showImportProjectDialog && (
        <ImportProjectDialog
          onClose={() => setShowImportProjectDialog(false)}
          onImported={(p) => {
            setShowImportProjectDialog(false);
            toast.success(`Imported ${p.name}`);
            setOwnedProjects(prev => [{ ...(p as any), chatCount: 0 }, ...prev]);
            router.push(`/projects/${p.id}`);
          }}
        />
      )}

      {/* ── Per-chat Autonomy editor (ticket ba733210) ── */}
      {autonomyChatId && (
        <AutonomyDialog
          chatId={autonomyChatId}
          chatTitle={chats.find((c) => c.id === autonomyChatId)?.title}
          onClose={() => setAutonomyChatId(null)}
        />
      )}

      {/* ── Deep search across all chats + messages (ticket 4fd1de3c) ── */}
      {!isKid && (
        <DeepSearchDialog
          open={deepSearchOpen}
          onOpenChange={setDeepSearchOpen}
          onSelect={handleOpenSearchResult}
        />
      )}

      {/* ── Move to Folder Dialog ── */}
      <Dialog open={!!movingChatId} onOpenChange={(open) => !open && setMovingChatId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="size-4 text-ink-3" />
              Move to Folder
            </DialogTitle>
            <DialogDescription>
              Add this conversation to a folder to use its knowledge base.
            </DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-3">
            <select
              value={movingToProjectId}
              onChange={e => setMovingToProjectId(e.target.value)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="">No folder (ungrouped)</option>
              {flatFolders.map((n) => (
                <option key={n.id} value={n.id}>
                  {'\u00A0\u00A0'.repeat(n.treeDepth)}{n.emoji ? `${n.emoji} ` : ''}{n.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {movingToProjectId
                ? `This chat will be moved to "${ownedProjects.find(p => p.id === movingToProjectId)?.name}" and will use its knowledge base in future messages.`
                : 'This chat will be removed from any folder.'
              }
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setMovingChatId(null)}>
              Cancel
            </Button>
            <Button
              className="flex-1 bg-send text-send-ink hover:opacity-90 border-0"
              onClick={handleMoveToProject}
            >
              <Check className="size-4 mr-2" />
              Move
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Share Chat Dialog ── */}
      <Dialog open={!!shareChatId} onOpenChange={(open) => !open && setShareChatId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="size-4 text-ink-3" />
              Share Chat
            </DialogTitle>
            <DialogDescription>
              Anyone with this link can view this conversation read-only.
            </DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-4">
            {loadingShare ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : shareChatUrl ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
                  <Link2 className="size-3.5 text-muted-foreground flex-shrink-0" />
                  <span className="text-xs text-muted-foreground truncate flex-1 font-mono">{shareChatUrl}</span>
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    onClick={() => {
                      navigator.clipboard.writeText(shareChatUrl);
                      setCopiedShareUrl(true);
                      setTimeout(() => setCopiedShareUrl(false), 2000);
                      toast.success('Link copied!');
                    }}
                  >
                    {copiedShareUrl ? <Check className="size-4 mr-2" /> : <Copy className="size-4 mr-2" />}
                    {copiedShareUrl ? 'Copied!' : 'Copy Link'}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleRevokeShareLink}
                    className="text-destructive hover:text-destructive border-destructive/40 hover:border-destructive"
                  >
                    Revoke
                  </Button>
                </div>
              </div>
            ) : (
              <div className="text-center space-y-3">
                <p className="text-sm text-muted-foreground">This chat doesn't have a share link yet.</p>
                <Button
                  className="w-full bg-send text-send-ink hover:opacity-90 border-0"
                  onClick={handleCreateShareLink}
                >
                  <Link2 className="size-4 mr-2" />
                  Create Share Link
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Digby Kids: parent-PIN gate for logging out (masked input) ── */}
      <Dialog open={kidLogoutOpen} onOpenChange={(open) => { if (!open) { setKidLogoutOpen(false); setKidLogoutPin(''); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LogOut className="size-4 text-ink-3" />
              Parent PIN required
            </DialogTitle>
            <DialogDescription>
              Ask a parent to enter the PIN to log out of this account.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); handleKidLogout(); }} className="space-y-3">
            <Input
              autoFocus
              type="password"
              inputMode="numeric"
              maxLength={6}
              placeholder="Parent PIN"
              value={kidLogoutPin}
              onChange={(e) => setKidLogoutPin(e.target.value.replace(/\D/g, ''))}
            />
            <div className="flex gap-2 justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={() => { setKidLogoutOpen(false); setKidLogoutPin(''); }}>Cancel</Button>
              <Button type="submit" size="sm" disabled={kidLogoutBusy || !kidLogoutPin} className="gap-1.5 bg-send text-send-ink hover:opacity-90">
                {kidLogoutBusy && <Loader2 className="size-3.5 animate-spin" />} Log out
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

    </div>
  );
}
