import apiClient from '../api-client';
import type { CodingSession } from './coding';
import type { SupervisorSwitchState, SupervisorSwitchTargetState } from './fleet';
import type { QueuedItem } from '../queue-controls';

export type ModelKey = 'openai' | 'grok' | 'gemini' | 'glm' | 'kimi' | 'deepseek';

export interface ModelResponse {
  model: ModelKey | string;
  response: string;
  time: number;
  error?: string;
  modelUsed?: string;       // Specific model/version (e.g. 'glm-5p1', 'deepseek-chat')
  webSearchUsed?: boolean;
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  metadata?: {
    mode: 'single' | 'single_thinking' | 'fast' | 'thinking' | 'deep_research' | 'deep_research_all' | 'browser_agent';
    webSearch?: boolean;
    modelSet?: 'frontier' | 'open_source';
    models: {
      // Frontier models
      openai?: ModelResponse;
      grok?: ModelResponse;
      gemini?: ModelResponse;
      // Open Source models
      glm?: ModelResponse;
      kimi?: ModelResponse;
      deepseek?: ModelResponse;
      // Index signature for flexibility
      [key: string]: ModelResponse | undefined;
    };
    summary: string;
    totalTime: number;
    sources?: RAGSource[]; // retrieved knowledge chunks
    /**
     * Attachment chips on USER rows (ticket c6e8edda): filename + type +
     * the staged uploadId stamped at send time; fileId + mimeType are
     * injected at READ time (getChatById joins the durable ChatFile rows)
     * so image chips render inline via the authed byte routes. All
     * optional — legacy chips carry filename + type only.
     */
    attachments?: Array<{
      filename: string;
      type: string;
      uploadId?: string;
      fileId?: string;
      mimeType?: string;
    }>;
  };
}

export interface RAGSource {
  documentId: string;
  documentName: string;
  mimeType: string;
  chunkIndex: number;
  content: string;
  relevanceScore: number;
  metadata?: { page?: number; section?: string; sourceUrl?: string };
}

export interface CrossModelChat {
  id: string;
  title: string;
  /** Owner (chat row's userId) — present on list + detail rows; the sidebar uses
   *  it to disable drag/move affordances on OTHER PEOPLE's chats in shared folders
   *  (ticket 7acaa7ba: move/rename/delete are owner-only server-side). */
  userId?: string;
  // 'auto' = the stored default since 2026-09-26 (the server routes it per send).
  mode: 'auto' | 'single' | 'single_thinking' | 'fast' | 'thinking' | 'deep_research' | 'deep_research_all' | 'browser_agent' | 'code';
  projectId?: string | null;
  /** Standing instructions (per-chat systemPrompt) — editable in Session settings since 2026-09-24; null = none. */
  systemPrompt?: string | null;
  /** Sub-session lineage: the chat whose run spawned this one (soft ref — the
   *  parent may be deleted/off-page; the sidebar then renders this chat flat). */
  parentChatId?: string | null;
  /** Display-only nesting fallback (2026-10-21): the folder's Project Supervisor for a
   *  machine-spawned lane (ticket / family / Fleet-spawned) — the sidebar nests under it
   *  only when parentChatId is not in the list. Never lineage: absent when the server
   *  runs with DISPLAY_PARENT_NESTING_DISABLED=1. */
  displayParentChatId?: string | null;
  messages: Message[];
  messageCount?: number;
  lastMessage?: string;
  /** Attention indicators: message-activity + live-run state for sidebar dots. */
  lastMessageAt?: string | null;
  lastMessageRole?: string | null;
  /** The newest row's `metadata.origin` — the trigger of its turn (owner
   *  2026-09-16): absent/'user' = a human turn; 'schedule' | 'hook' | 'agent' |
   *  'machine' | … = machine traffic that must never light the unread dot. */
  lastMessageOrigin?: string | null;
  running?: boolean;
  awaitingInput?: boolean;
  awaitingKind?: 'approval' | 'question' | null;
  /** Sidebar indicator: the chat has at least one ENABLED schedule row. */
  hasActiveSchedule?: boolean;
  /** Fleet Supervisor: the owner's ONE global autonomous supervisor chat (pinned at the top of the sidebar). */
  isSupervisor?: boolean;
  /** Per-project supervisor lane (2026-09-14) — machine-authored surface: UTC clocks in its text are shown in the viewer's local time.
   *  List rows carry it since 2026-10-22 (the ghost controls hide on supervisor chats). */
  isProjectSupervisor?: boolean;
  /** P5-B capability flags (satellite / workspace-folder resolution) — present on
   *  list rows AND the detail DTO; coding-ness is capability, never the mode column. */
  codeCapable?: boolean;
  hasWorkspaceState?: boolean;
  shareLink?: { shareToken: string; isActive: boolean } | null;
  /** Per-chat "ghost mode" (2026-10-22): true = the chat's models are routed
   *  to the admin-designated self-hosted endpoint and the chat is kept out of
   *  memory / learning / cross-chat surfacing. Absent on older backends —
   *  treat as false. */
  ghostMode?: boolean;
  /** Archive (owner 2026-09-08): non-null = archived (hidden from default lists,
   *  still loadable by id). Restore clears it. */
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Project types ─────────────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  systemPrompt?: string | null;
  emoji?: string | null;
  // One-Digby workspace (Phase 1)
  repoUrl?: string | null;
  repoProvider?: 'github' | 'git' | 'local' | 'blank' | null;
  defaultBranch?: string;
  workspaceAt?: string | null;
  color?: string | null;
  isPublic: boolean;
  shareToken?: string | null;
  // P2 folder tree: null parent = root folder; depth 0..5; path is the
  // materialized '/rootId/.../id' chain (server-maintained).
  parentId?: string | null;
  depth?: number;
  path?: string | null;
  chatCount: number;
  documentCount: number;
  memberCount?: number;
  /** User Space (P3, docs/USER_SPACE_DESIGN.md): the owner's ONE hidden personal
   *  project every chat auto-files into. Never renders in the folder tree,
   *  pickers, or project pages — its chats render as the sidebar's ungrouped
   *  section. Personal forever (no members/sharing). */
  isUserSpace?: boolean;
  /** Framework surface (ticket 9471d338): the platform's own project (identity =
   *  its repoUrl resolving to the instance's repo). Never renders in the user
   *  sidebar — Management → Framework is its home — and the API refuses
   *  rename/move/delete/archive/share/members on it. */
  isFrameworkProject?: boolean;
  /** Archive (owner 2026-09-08): non-null = archived. The folder (and its chats
   *  + subfolders, implicitly) hides from default lists; restore clears it. */
  archivedAt?: string | null;
  /** Per-project DEDICATED supervisor agent (2026-09-14) — separate from the
   *  `supervised` fleet-wildcard flag. True = scaffold the project's own
   *  supervisor chat (within a minute); false (the default) = paused/absent. */
  projectSupervisorEnabled?: boolean;
  /** The project's supervisor chat id (null until first scaffold; a paused supervisor keeps its chat). */
  projectSupervisorChatId?: string | null;
  /** Auto-archive idle chats (ticket bb86cee8): the hourly archiver moves this
   *  folder's chats idle longer than this many days to Archived (skips
   *  scheduled/running/shared/supervisor chats). null/absent = off. */
  autoArchiveIdleDays?: number | null;
  /** Daily USD spend cap for the project's machine runs (trailing 24h); null = no cap. Budget & merge policy block (T4c, 2026-09-24). */
  spendCapUsdPerDay?: number | null;
  /** Machine self-merge policy: 'on' | 'off' | null = platform default. */
  selfMerge?: 'on' | 'off' | null;
  /** Gmail auto-ingest (ticket 99145890): true = gmail_get_attachment runs in
   *  this folder file the attachment into its knowledge base automatically
   *  (dedup by messageId+filename). Default false/absent. */
  autoIngestGmailAttachments?: boolean;
  /** Ticket 7acaa7ba: this folder is shared WITH the viewer (they are a member,
   *  not the owner) — the sidebar tree renders it with a shared badge, disables
   *  drag/drop on it, and hides owner-only affordances. Client-side marker only
   *  (stamped by page.tsx from the /projects `shared` list). */
  isSharedFolder?: boolean;
  /** Shared-project extras (the /projects `shared` rows): who shared it and the
   *  viewer's own role there. */
  ownerName?: string;
  memberRole?: 'viewer' | 'editor' | 'admin';
  createdAt: string;
  updatedAt: string;
}

export interface SharedProject extends Project {
  ownerName: string;
  memberRole: 'viewer' | 'editor' | 'admin';
}

export interface ProjectMember {
  userId: string;
  role: 'viewer' | 'editor' | 'admin';
  addedAt: string;
  user: { id: string; name?: string | null; email: string; avatar?: string | null };
}

export interface ProjectDocument {
  id: string;
  name: string;
  mimeType: string;
  sourceUrl?: string | null;
  /** 'gmail_attachment' = ingested from a Gmail attachment (ticket 99145890) —
   *  sourceUrl then carries the gmail://<messageId>/<filename> dedup key. */
  source: 'knowledge' | 'chat_upload' | 'gmail_attachment';
  charCount: number;
  chunkCount: number;
  status: 'processing' | 'ready' | 'error';
  errorMsg?: string | null;
  createdAt: string;
  project?: { id: string; name: string; emoji?: string | null; color?: string | null } | null;
}

export interface ProjectDetail extends Project {
  userId: string;
  role: 'owner' | 'viewer' | 'editor' | 'admin';
  /** When true, chats in this project may also draw relevant knowledge from the user's other projects. */
  crossProjectMemory?: boolean;
  /** Fleet-supervision opt-in (ticket 3217e287). Optional = old-backend deploy skew. False = opted out. */
  supervised?: boolean;
  /** Project-level coding agent override; null/absent = default. */
  codingModel?: string | null;
  chats: CrossModelChat[];
  documents: ProjectDocument[];
  members: ProjectMember[];
}

// ── Chat API ──────────────────────────────────────────────────────────────────

/** GET /chats/:id payload — a chat plus its transcript. With the opt-in paging
 *  params (messageLimit/messagesBefore) the transcript is the NEWEST page and
 *  the envelope carries the paging state (the cursor travels in the envelope
 *  only — message objects keep their legacy shape, no id). */
export interface CrossModelChatDetail extends CrossModelChat {
  access?: 'none' | 'read' | 'write' | 'owner';
  /**
   * A run is answering in this chat RIGHT NOW — the cross-process busy truth
   * (in-process registry ∪ Redis `cm:liverun:*` ∪ durable agent_runs), the
   * same value `listChats` ships as `CrossModelChat.running`. Ticket
   * 5060c3d2: the unified view uses it to attach to an in-flight run on open,
   * so returning to a chat mid-response restores live progress instead of
   * implying the run died. Absent (`undefined`) on an older backend — callers
   * must treat that as "no evidence", never as `false`-means-ended.
   */
  running?: boolean;
  /** Paged fetch only: older messages exist beyond this page. */
  hasMoreMessages?: boolean;
  /** Paged fetch only: cursor for the next OLDER page (messagesBefore param). */
  nextMessagesBefore?: string;
}

/** One schedule row on a chat (mirrors the backend ScheduleView —
 *  coding/schedule.service.ts), daily firing-cap state included. */
export interface ChatScheduleRow {
  id: string;
  kind: 'once' | 'recurring';
  prompt: string;
  intervalSec: number | null;
  nextRunAt: string;
  enabled: boolean;
  runsCount: number;
  maxRuns: number | null;
  expiresAt: string | null;
  lastFiredAt: string | null;
  lastStatus: string | null;
  /** Who disabled the row ('owner' | 'machine'); null while enabled/resumed. */
  cancelledBy: string | null;
  /** When the row was last disabled (ISO); null while enabled/resumed. */
  disabledAt: string | null;
  /** Firings used in the current 24h window; null when unreadable. */
  dailyFiresUsed: number | null;
  dailyCapLimit: number;
  capWindowResetsAt: string | null;
  /** Raw cadence projection (ticket 2694a581): firings/day if every tick fires; null for one-shots. */
  projectedDailyFirings: number | null;
  /** Signed per-firing clock drift in minutes (ticket 903249e5): negative = each
   *  firing lands EARLIER than the last (a ≥12h non-day-aligned cadence marches
   *  around the clock); 0 = day-aligned; null for one-shots. */
  clockDriftMinutes: number | null;
  /** Projected next 3 firings, ISO (ticket 903249e5); null for one-shots. */
  projectedNextFirings: string[] | null;
}

export const crossModelApi = {
  // P4: 'auto' is accepted on create — the server never persists it (stores the
  // L2 'thinking' default); it only steers the first message's routing.
  createChat: async (data: { title: string; mode?: 'single' | 'single_thinking' | 'fast' | 'thinking' | 'deep_research' | 'deep_research_all' | 'browser_agent' | 'auto'; projectId?: string; ghostMode?: boolean }) => {
    const response = await apiClient.post('/crossmodel/chats', data);
    return response.data;
  },

  /** Default lists exclude archived chats; `archived: true` flips to the
   *  Archived browse view (the caller's own archived chats only). */
  listChats: async (params?: { page?: number; limit?: number; archived?: boolean }) => {
    const response = await apiClient.get('/crossmodel/chats', { params });
    return response.data.data;
  },

  /** Sidebar live delta (ticket d6b2eef5): chats updated at/after `since`
   *  (ISO), newest first, same row shape as listChats. (`disabled: true` came
   *  from a backend kill switch deleted in build 2026-10-08 S-2 — no longer sent.)
   *  includeArchived (ticket 6201e0ee): also rows just archived by ANOTHER
   *  lane (the push-kicked fetch) — the caller filters rendering itself. */
  listChatChanges: async (
    params: { since: string; limit?: number; includeArchived?: boolean },
    opts?: { signal?: AbortSignal },
  ): Promise<{ chats: CrossModelChat[]; total?: number; disabled?: boolean }> => {
    const response = await apiClient.get('/crossmodel/chats/changes', { params, signal: opts?.signal });
    return response.data.data;
  },

  getChat: async (id: string, opts?: { messageLimit?: number; messagesBefore?: string }): Promise<CrossModelChatDetail> => {
    // Opt-in transcript paging: no opts = legacy full transcript (unchanged).
    const params: Record<string, string | number> = {};
    if (opts?.messageLimit !== undefined) params.messageLimit = opts.messageLimit;
    if (opts?.messagesBefore) params.messagesBefore = opts.messagesBefore;
    const response = await apiClient.get(`/crossmodel/chats/${id}`, { params });
    return response.data.data;
  },

  updateChat: async (id: string, data: { title?: string; mode?: 'single' | 'single_thinking' | 'fast' | 'thinking' | 'deep_research' | 'deep_research_all' | 'browser_agent'; projectId?: string | null; systemPrompt?: string | null; ghostMode?: boolean }) => {
    const response = await apiClient.put(`/crossmodel/chats/${id}`, data);
    return response.data.data;
  },

  deleteChat: async (id: string) => {
    const response = await apiClient.delete(`/crossmodel/chats/${id}`);
    return response.data;
  },

  /** Archive a chat (owner-only): it leaves the sidebar/search but stays
   *  loadable by id. 409 while a run is active or schedules are enabled. */
  archiveChat: async (id: string): Promise<{ id: string; archived: boolean }> => {
    const response = await apiClient.post(`/crossmodel/chats/${id}/archive`);
    return response.data.data;
  },

  /** Restore an archived chat — the lossless inverse; it reappears in place. */
  restoreChat: async (id: string): Promise<{ id: string; archived: boolean }> => {
    const response = await apiClient.post(`/crossmodel/chats/${id}/restore`);
    return response.data.data;
  },

  /** The Archived browse view: the caller's own archived chats, newest first. */
  listArchivedChats: async (params?: { page?: number; limit?: number }) => {
    const response = await apiClient.get('/crossmodel/chats', { params: { ...params, archived: true } });
    return response.data.data;
  },

  /** In-place plain→coding escalation: attach the workspace satellite to THIS
   *  chat (history preserved — the coding transcript reads the same message
   *  store). `projectId` moves the chat into that workspace folder first; omit
   *  it when the chat's current folder chain already resolves a workspace. */
  convertToCoding: async (id: string, projectId?: string): Promise<CodingSession> => {
    const response = await apiClient.post(`/crossmodel/chats/${id}/coding`, projectId ? { projectId } : {});
    return response.data.data;
  },

  /** Actually cancel a live agent run server-side (detach-only viewers keep
   *  running otherwise). Also force-resolves a parked ask_user wait. */
  stopAgentRun: async (chatId: string): Promise<{ stopping: boolean }> => {
    const response = await apiClient.post('/crossmodel/agent/stop', { chatId });
    return response.data.data;
  },

  /** The chat's USER messages waiting behind a live run, in DRAIN order
   *  (ticket ea04454c) — position, content, attachment count. Machine relay
   *  rows and other people's rows are never returned. */
  listChatQueue: async (chatId: string): Promise<QueuedItem[]> => {
    const response = await apiClient.get(`/crossmodel/chats/${chatId}/queue`);
    return response.data.data?.queue || [];
  },

  /** Drop one of MY queued messages before it fires (ea04454c). Returns the
   *  fresh queue so the panel re-renders from server truth. */
  cancelChatQueueItem: async (chatId: string, pendingId: string): Promise<QueuedItem[]> => {
    const response = await apiClient.post(`/crossmodel/chats/${chatId}/queue/${pendingId}/cancel`);
    return response.data.data?.queue || [];
  },

  /** Make it the NEXT turn when the live run finishes. Deliberately does not
   *  stop the run — the caller pairs it with a Stop when the person chose
   *  "run now" (interrupt). */
  promoteChatQueueItem: async (chatId: string, pendingId: string): Promise<QueuedItem[]> => {
    const response = await apiClient.post(`/crossmodel/chats/${chatId}/queue/${pendingId}/promote`);
    return response.data.data?.queue || [];
  },

  /** Reorder one of MY queued messages by one slot (ea04454c). */
  moveChatQueueItem: async (chatId: string, pendingId: string, direction: 'up' | 'down'): Promise<QueuedItem[]> => {
    const response = await apiClient.post(`/crossmodel/chats/${chatId}/queue/${pendingId}/move`, { direction });
    return response.data.data?.queue || [];
  },

  /** The chat's schedule rows (enabled + terminal) — the workspace panel's
   *  Schedules tab. Any chat (coding or plain); read-level access. */
  listChatSchedules: async (chatId: string): Promise<ChatScheduleRow[]> => {
    const response = await apiClient.get(`/crossmodel/chats/${chatId}/schedules`);
    return response.data.data?.schedules || [];
  },

  /** Cancel (disable) one schedule on this chat — owner-only, no confirmation
   *  round-trip (the UI offers a short Undo via setChatScheduleEnabled(true)
   *  instead: cancel persists the row as enabled:false, nothing is destroyed).
   *  `warning` carries the backend's deaf-lane notice when the chat is left
   *  with ZERO enabled schedules — surface it, don't swallow it. */
  cancelChatSchedule: async (chatId: string, scheduleId: string): Promise<{ cancelled: boolean; alreadyDisabled: boolean; warning: string | null }> => {
    const response = await apiClient.delete(`/crossmodel/chats/${chatId}/schedules/${scheduleId}`);
    return response.data.data;
  },

  /** Pause (false) / resume (true) one schedule on this chat — owner-only.
   *  Resume recomputes a stale nextRunAt server-side (never an immediate
   *  catch-up fire) and 409s on completed schedules / the active-schedule cap. */
  setChatScheduleEnabled: async (chatId: string, scheduleId: string, enabled: boolean): Promise<{ schedule: ChatScheduleRow; changed: boolean }> => {
    const response = await apiClient.patch(`/crossmodel/chats/${chatId}/schedules/${scheduleId}`, { enabled });
    return response.data.data;
  },

  /** Deep search across ALL the user's chats + messages (sidebar search box).
   *  Case-insensitive, scoped to the caller; returns ranked, capped results.
   *  Queries shorter than 2 chars are answered locally with an empty list so a
   *  blank/1-char box never hits the network. */
  searchChats: async (q: string): Promise<ChatSearchResult[]> => {
    const query = (q || '').trim();
    if (query.length < 2) return [];
    const response = await apiClient.get('/crossmodel/chats/search', { params: { q: query } });
    return response.data.data?.results || [];
  },
};

/** One deep-search hit — a chat whose TITLE matched, or a message whose CONTENT
 *  matched (then `messageRole` is set and `snippet` is windowed around the term). */
export interface ChatSearchResult {
  chatId: string;
  chatTitle: string;
  snippet: string;
  messageRole: 'user' | 'assistant' | null;
  matchedAt: string;
  projectId: string | null;
}

// ── Confirmations API (first-class confirmation UX) ──────────────────────────

/** One chat currently blocked on a human — an ask_user question (chat run or
 *  coding session), an ask-only approval, a DB-persisted consequential-tool
 *  confirmation (kind 'confirmation': the owner confirms/cancels it inline via
 *  POST /crossmodel/confirmations/:id/confirm|cancel), or a "Needs owner"
 *  flagged question (kind 'owner_question': NEVER expires — answered/dismissed
 *  via POST /crossmodel/owner-questions/:id/answer|dismiss, ticket 7705fec2).
 *  Served by GET /crossmodel/confirmations/pending (the sidebar banner poll). */
export interface PendingConfirmation {
  chatId: string;
  title: string;
  kind: 'question' | 'approval' | 'confirmation' | 'owner_question';
  /** questionId / approvalId — the id the matching resolve endpoint takes. */
  id: string;
  /** Human-displayable prompt (the ask_user question, or "Allow <tool>…?"). */
  question: string;
  options: string[];
  /** The gated tool name — approvals only. */
  tool?: string;
  /** When the wait started (ms epoch). */
  ts: number;
  /** Soft answer deadline (ms epoch) — questions only. Clients render a
   *  countdown from it and auto-expire the card; a server grace window beyond
   *  it still absorbs in-flight answers. */
  expiresAt?: number;
  /** Confirmations only: the staged action LAPSED without a decision and is
   *  surfaced briefly as a non-actionable trace (never Confirm/Cancel). */
  expired?: boolean;
  /** Confirmations only (ticket 7705fec2): still pending — the card persists
   *  until answered — but past the execution-freshness horizon: Confirm would
   *  refuse ("stale"), so render Dismiss plus a re-stage hint instead. */
  stale?: boolean;
  /** Owner questions only: a supervisor is answering this first. It surfaces
   *  as a normal question at `triageUntil` (ms epoch) if still open; the owner
   *  may answer now to pre-empt. Not counted as "needs you". */
  triaged?: boolean;
  triageUntil?: number;
  /** Owner questions only (ticket ad4fae90): the row is credential-gated
   *  (expectedAnswerType 'credential:<ENVKEY>') — answer text never resolves
   *  it. The card renders a dedicated secret input whose submit posts
   *  { credentialPaste: true } so the server vault-stores the value and lifts
   *  the gate on that very answer. */
  needsCredential?: boolean;
  /** Owner questions only (2026-10-20): the flagger's `context` — what it
   *  tried, the policy / console steps the owner needs — scrubbed server-side
   *  at flag time. Rendered collapsed under the question ("Details from the
   *  agent"); before this the card showed the question alone and anything the
   *  agent put in context never reached the owner. */
  context?: string;
  /** Owner questions only (ticket 1b1c41bc): the row asks the owner to act
   *  in an EXTERNAL console — the question body carries the harness-composed
   *  four elements (paste-ready payload code block, click-by-click steps +
   *  console URL, what/why-safe line, typed saved/error/defer options). The
   *  card renders fully expanded (no collapsed plain-text preview, which
   *  would hide the payload). */
  consoleAction?: boolean;
  /** Owner questions only (ticket 26786762): credentials this card DELIVERS
   *  — masked previews (last-4); the card renders a Reveal/Copy affordance
   *  per entry. The value itself lives server-side, encrypted; reveal posts
   *  to the owner-scoped endpoint and is shown once in place. */
  secrets?: Array<{ ordinal: number; label: string; preview: string }>;
  /** Owner questions only (ticket f3a69ed3): the owner's own reply on this
   *  still-OPEN card, recorded because it did not resolve the card's typed
   *  shape (words on a credential gate; a free-text answer on a choice
   *  card). Rendered back ON the card — the owner's words, the one-line
   *  reason they did not resolve, and where the reply went — so a reply is
   *  never a silent bounce. `legacy` marks pre-f3a69ed3 records (no
   *  receivedAt). */
  recordedReply?: {
    text: string;
    receivedAt: string | null;
    reason: string;
    delivered: string;
    legacy?: boolean;
  };
  /** Owner questions only (ticket f3a69ed3, defect 2): this card REPLACED an
   *  earlier card the owner had replied to — his reply is folded onto this
   *  card's question so a supersede can never hide it. The id is the
   *  predecessor's; the text is his reply on it. */
  priorReplyFold?: { fromQuestionId: string; text: string };
  /** Confirmations only (cohesive chat, 2026-09-28): who staged it — true = a
   *  machine wake (schedule / hook / agent-triggered run), false = the user's
   *  own turn (pending_confirmations.origin). Legacy rows carry no flag.
   *  INFORMATIONAL: nothing hides a card on it — a staged card always needs
   *  the click (the server never stages a human-turn spawn it executed). */
  machine?: boolean;
}

export const credentialVaultApi = {
  /** One-tap "vault this" (feedback ticket f95e1e30, part 2): vault every
   *  credential-shaped value of ONE of the caller's own pasted messages.
   *
   *  The client sends NO value — the id says which row, and the server lifts the
   *  bytes from the persisted message exactly as `store_secret` does. The answer
   *  names env keys / pattern names / refusal reasons and NEVER a value:
   *  `stored` is every key the vault holds, `notStored` is everything it could
   *  not store (so a partial vault is never silent).
   *
   *  Authed by the app-level /api/crossmodel guard + apiClient's bearer; a row
   *  in someone else's chat answers 404 (no existence leak), a machine-authored
   *  row inside your own chat answers 403 NOT_OWNER_TYPED. */
  vaultMessage: async (chatId: string, messageId: string): Promise<{
    ok: boolean;
    reason?: string;
    stored: Array<{ envKey: string; injectedKey: string; pattern: string; replaced: boolean }>;
    notStored: Array<{ n: number; pattern: string; envKey: string; reason: string }>;
    message: string;
  }> => {
    const r = await apiClient.post(`/crossmodel/chats/${chatId}/messages/${messageId}/vault`);
    return r.data;
  },
};

export const confirmationsApi = {
  /** Every chat of the user's currently blocked on a human (sidebar banner poll). */
  getPending: async (opts?: { signal?: AbortSignal }): Promise<PendingConfirmation[]> => {
    const response = await apiClient.get('/crossmodel/confirmations/pending', { signal: opts?.signal });
    return response.data.pending || [];
  },

  /** Answer an ask_user question a CHAT run is blocked on. Resolves
   *  { success: false, error: 'unknown_or_expired' } when the wait is gone
   *  (timeout / Stop / answered from another surface). */
  answerChatQuestion: async (chatId: string, questionId: string, answer: string): Promise<{ success: boolean; error?: string }> => {
    const response = await apiClient.post(`/crossmodel/chats/${chatId}/questions/${questionId}`, { answer });
    return response.data;
  },

  /** Confirm a DB-persisted staged consequential action (sidebar pending-action
   *  card) — the server consumes the row one-shot and executes the STORED args. */
  confirmAction: async (confirmationId: string): Promise<{ success: boolean; result?: string; error?: string }> => {
    const response = await apiClient.post(`/crossmodel/confirmations/${confirmationId}/confirm`);
    return response.data;
  },

  /** Cancel a staged consequential action (sidebar pending-action card). */
  cancelAction: async (confirmationId: string): Promise<{ success: boolean; error?: string }> => {
    const response = await apiClient.post(`/crossmodel/confirmations/${confirmationId}/cancel`);
    return response.data;
  },

  /** Answer a flagged "Needs owner" question (ticket 7705fec2) — the answer is
   *  posted back into the flagging chat's transcript for the agent's next turn.
   *  credentialPaste (ticket ad4fae90): set when submitted from the card's
   *  dedicated secret input — the server vault-stores the value and lifts a
   *  credential gate on that very answer. pasteRefused in the response: the
   *  question resolved but THIS value was not stored (preset-managed key /
   *  size limit / kill switch) — the card must not toast "Key stored". */
  answerOwnerQuestion: async (id: string, answer: string, opts?: { credentialPaste?: boolean }): Promise<{ success: boolean; error?: string; message?: string; pasteRefused?: boolean }> => {
    const response = await apiClient.post(`/crossmodel/owner-questions/${id}/answer`, { answer, ...(opts?.credentialPaste ? { credentialPaste: true } : {}) });
    return response.data;
  },

  /** Dismiss a flagged "Needs owner" question ("stop raising this" — the agent
   *  is told, and a 24h re-flag cooldown applies). */
  dismissOwnerQuestion: async (id: string): Promise<{ success: boolean; error?: string }> => {
    const response = await apiClient.post(`/crossmodel/owner-questions/${id}/dismiss`);
    return response.data;
  },

  /** Reveal ONE credential a "Needs owner" card delivers (ticket 26786762).
   *  Owner-scoped server-side; the value is decrypted on demand and returned
   *  once — the caller shows it in place with a copy affordance. 'unreadable'
   *  = the stored value no longer decrypts (JWT_SECRET rotated since the
   *  delivery); nothing to show. */
  revealOwnerQuestionSecret: async (id: string, ordinal: number): Promise<{ ordinal?: number; label?: string; value?: string; error?: string }> => {
    const response = await apiClient.post(`/crossmodel/owner-questions/${id}/secrets/${ordinal}/reveal`);
    return response.data;
  },
};

// ── Projects API ──────────────────────────────────────────────────────────────

/** Sessions view row (session titles + topology, 2026-09-27) — GET /projects/:id/sessions. */
export interface ProjectSessionRow {
  chatId: string;
  title: string;
  goalHalf: string;
  stepHalf: string | null;
  pinned: boolean;
  status: 'running' | 'scheduled' | 'idle' | 'archived';
  lastReceiptAgeSec: number | null;
  spendTodayUsd: number | null;
  goalId: string | null;
  goalTitle: string | null;
  todoCounts: { open: number };
  runs14d: number;
  enabledSchedules: number;
  isSupervisor: boolean;
  hasWorkspaceState: boolean;
  updatedAt: string;
  archivedAt: string | null;
}

export const projectsApi = {
  /** List owned + shared projects */
  list: async (): Promise<{ owned: Project[]; shared: SharedProject[] }> => {
    const response = await apiClient.get('/crossmodel/projects');
    return response.data;
  },

  /** Sessions view (2026-09-27): title halves, status, last receipt age, today's spend and charter per chat. */
  sessions: async (id: string, opts: { archived?: boolean } = {}): Promise<{ projectId: string; sessions: ProjectSessionRow[]; partial: boolean }> => {
    const response = await apiClient.get(`/crossmodel/projects/${id}/sessions`, { params: opts.archived ? { archived: '1' } : {} });
    return response.data;
  },

  /** Create a new project (optionally nested under a parent folder) */
  create: async (data: {
    name: string;
    description?: string;
    systemPrompt?: string;
    emoji?: string;
    color?: string;
    parentId?: string | null;
  }): Promise<Project> => {
    const response = await apiClient.post('/crossmodel/projects', data);
    return response.data;
  },

  /** Move a folder to a new parent (null = root). 400 on cycle/depth violation. */
  move: async (id: string, parentId: string | null): Promise<Project> => {
    const response = await apiClient.post(`/crossmodel/projects/${id}/move`, { parentId });
    return response.data;
  },

  /** Breadcrumb chain root→…→folder for a folder */
  getBreadcrumbs: async (id: string): Promise<{ breadcrumbs: Project[] }> => {
    const response = await apiClient.get(`/crossmodel/projects/${id}/breadcrumbs`);
    return response.data;
  },

  /** Get full project detail (chats, documents, members) */
  get: async (id: string, opts?: { signal?: AbortSignal }): Promise<ProjectDetail> => {
    const response = await apiClient.get(`/crossmodel/projects/${id}`, { signal: opts?.signal });
    return response.data;
  },

  /** Update project metadata */
  update: async (
    id: string,
    data: {
      name?: string;
      description?: string;
      systemPrompt?: string;
      emoji?: string;
      color?: string;
      isPublic?: boolean;
      supervised?: boolean;
      /** Dedicated per-project supervisor agent: true scaffolds it, false pauses (never deletes). */
      projectSupervisorEnabled?: boolean;
      /** Auto-archive idle chats window in days (integer 1..365); null clears it (feature off). */
      autoArchiveIdleDays?: number | null;
      crossProjectMemory?: boolean;
      /** Project-level coding agent: built-in id or '<label>:<modelId>' endpoint spec; '' clears. */
      codingModel?: string;
      /** Daily USD spend cap (trailing 24h); null clears. */
      spendCapUsdPerDay?: number | null;
      /** Machine self-merge policy; null = platform default. */
      selfMerge?: 'on' | 'off' | null;
      /** Gmail auto-ingest (ticket 99145890): true = gmail_get_attachment
       *  runs in this project file the attachment into the knowledge base
       *  automatically (dedup by messageId+filename). Default false. */
      autoIngestGmailAttachments?: boolean;
    }
  ): Promise<Project> => {
    const response = await apiClient.put(`/crossmodel/projects/${id}`, data);
    return response.data;
  },

  /** Delete project */
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/projects/${id}`);
  },

  /** Archive a folder (owner-only): it and its chats/subfolders leave the
   *  default lists; restore brings the whole subtree back losslessly. 409
   *  while coding sessions run or schedules are enabled inside it. */
  archive: async (id: string): Promise<{ id: string; archived: boolean }> => {
    const response = await apiClient.post(`/crossmodel/projects/${id}/archive`);
    return response.data.data;
  },

  /** Restore an archived folder — its chats and subfolders reappear in place. */
  restore: async (id: string): Promise<{ id: string; archived: boolean }> => {
    const response = await apiClient.post(`/crossmodel/projects/${id}/restore`);
    return response.data.data;
  },

  /** The Archived browse view: individually-archived folders only (their
   *  descendants ride along and are restored WITH them). */
  listArchived: async (): Promise<{ owned: Project[]; shared: SharedProject[] }> => {
    const response = await apiClient.get('/crossmodel/projects', { params: { archived: true } });
    return response.data;
  },

  /** Add or invite a member by email */
  addMember: async (
    id: string,
    data: { email: string; role?: 'viewer' | 'editor' | 'admin' }
  ): Promise<ProjectMember> => {
    const response = await apiClient.post(`/crossmodel/projects/${id}/members`, data);
    return response.data;
  },

  /** Update member role */
  updateMember: async (
    id: string,
    memberId: string,
    role: 'viewer' | 'editor' | 'admin'
  ): Promise<void> => {
    await apiClient.put(`/crossmodel/projects/${id}/members/${memberId}`, { role });
  },

  /** Remove a member */
  removeMember: async (id: string, memberId: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/projects/${id}/members/${memberId}`);
  },

  /** Enable/disable project sharing */
  share: async (
    id: string,
    enable: boolean
  ): Promise<{ shareToken?: string; shareUrl?: string }> => {
    const response = await apiClient.post(`/crossmodel/projects/${id}/share`, { enable });
    return response.data;
  },

  /** Create a new chat inside a project */
  createChat: async (
    id: string,
    data: { title?: string; mode?: 'single' | 'single_thinking' | 'fast' | 'thinking' | 'deep_research' | 'deep_research_all' | 'browser_agent' }
  ): Promise<CrossModelChat> => {
    const response = await apiClient.post(`/crossmodel/projects/${id}/chats`, data);
    return response.data;
  },

  /** Get public project by share token (no auth) */
  getPublic: async (token: string) => {
    const response = await apiClient.get(`/crossmodel/shared/project/${token}`);
    return response.data;
  },

  // ── One-Digby workspace (Phase 1) ───────────────────────────────────────────
  getWorkspace: async (id: string): Promise<{ provider: string | null; repoUrl: string | null; defaultBranch: string; provisioned: boolean; workspaceAt: string | null; knowledgeBranch: string | null } | null> => {
    const response = await apiClient.get(`/crossmodel/projects/${id}/workspace`);
    return response.data?.data ?? null;
  },
  configureWorkspace: async (id: string, data: { repoUrl?: string; provider?: 'github' | 'git' | 'local'; defaultBranch?: string; githubLabel?: string | null } = {}) => {
    const response = await apiClient.post(`/crossmodel/projects/${id}/workspace`, data);
    return response.data?.data;
  },
  syncWorkspace: async (id: string): Promise<{ committed: number; skipped: number }> => {
    const response = await apiClient.post(`/crossmodel/projects/${id}/workspace/sync`, {});
    return response.data?.data;
  },
};

// ── Sharing API (chat share links) ────────────────────────────────────────────

// ── Public shared chat (no auth) ──────────────────────────────────────────────

/** One generated image on a public shared-chat message (generate_image tranche B, 2026-09-24). */
export interface SharedChatImage {
  /** GeneratedFile id — the token-scoped byte route is keyed on it. */
  fileId: string;
  /** Token-scoped PUBLIC byte route as an API path (/api/crossmodel/shared/chat/<token>/image/<fileId>). */
  url: string;
  /** Caption ("Generated · 1024×1024 · "…""). */
  name?: string;
  prompt?: string;
  mediaType?: string;
}

export interface SharedChatMessage {
  role: 'user' | 'assistant' | string;
  content: string;
  timestamp: string;
  metadata?: Record<string, any>;
  /** Generated images on this message — ONLY generate_image results; the
   *  public payload never carries tool parts, screenshots or base64. Absent
   *  when the message has none. */
  images?: SharedChatImage[];
}

export interface SharedChat {
  id: string;
  title: string;
  mode: string;
  messages: SharedChatMessage[];
  ownerName: string;
  project: { id: string; name: string; emoji: string | null; color: string | null } | null;
  sharedAt: string;
  expiresAt: string | null;
}

export const sharingApi = {
  /** Get current share link status for a chat */
  getChatShareStatus: async (chatId: string) => {
    const response = await apiClient.get(`/crossmodel/chats/${chatId}/share`);
    return response.data as {
      hasShareLink: boolean;
      shareToken?: string;
      shareUrl?: string;
      expiresAt?: string | null;
      createdAt?: string;
    };
  },

  /** Create or re-activate a share link for a chat */
  shareChatLink: async (chatId: string, expiresInDays?: number | null) => {
    const response = await apiClient.post(`/crossmodel/chats/${chatId}/share`, {
      expiresInDays: expiresInDays ?? null,
    });
    return response.data as {
      shareToken: string;
      shareUrl: string;
      isActive: boolean;
      expiresAt: string | null;
    };
  },

  /** Revoke a chat share link */
  revokeChatLink: async (chatId: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/chats/${chatId}/share`);
  },

  /** Get public shared chat by token (no auth) */
  getSharedChat: async (token: string): Promise<SharedChat> => {
    const response = await apiClient.get(`/crossmodel/shared/chat/${token}`);
    return response.data as SharedChat;
  },

  /** Absolute URL of a shared chat's generated image — the token-scoped public
      byte route (no auth, no cookie; same apiBase rule as filesApi.inlineGeneratedUrl). */
  sharedChatImageUrl: (token: string, fileId: string): string => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    return `${apiBase}/crossmodel/shared/chat/${encodeURIComponent(token)}/image/${encodeURIComponent(fileId)}`;
  },
};

// ── Files API ─────────────────────────────────────────────────────────────────

export interface GeneratedFileMeta {
  id: string;
  filename: string;
  format: string;
  mimeType: string;
  size: number;
  createdAt: string;
  /** Chat the file was created in, when known (nullable bare column — no FK). */
  chatId?: string | null;
}

export const filesApi = {
  /** List all documents across all projects */
  listAll: async (): Promise<ProjectDocument[]> => {
    const response = await apiClient.get('/crossmodel/files');
    return response.data;
  },

  /** List the caller's agent-generated files (metadata only). Pass chatId to
      filter server-side (2026-08-31) — the old client-side filter over the
      200-row user-wide list lost attribution for older rows. */
  listGenerated: async (chatId?: string): Promise<GeneratedFileMeta[]> => {
    const response = await apiClient.get('/crossmodel/generated-files', {
      params: chatId ? { chatId } : undefined,
    });
    return response.data;
  },

  /** Delete an agent-generated file */
  deleteGenerated: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/generated-files/${id}`);
  },

  /**
   * Absolute INLINE byte URL of a generated file (image/* only — 415 for
   * anything else; mirrors chatFilesApi.inlineUrl). Generated images
   * (2026-09-24) are served here with `Content-Disposition: inline`, so the
   * URL works both as an authed fetch target (AuthedFileImage) and, on the
   * cookie/query-token twin route, as a plain `<img src>` / new-tab Open.
   */
  inlineGeneratedUrl: (id: string): string => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    return `${apiBase}/crossmodel/generated-files/${id}/inline`;
  },

  /** Download an agent-generated file (raw fetch + Bearer, same pattern as uploadToProject) */
  downloadGenerated: async (id: string, filename: string): Promise<void> => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const res = await fetch(
      `${apiBase}/crossmodel/generated-files/${id}/download`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw { response: { data: err } };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  /** Upload a file to a project */
  uploadToProject: async (projectId: string, file: File): Promise<ProjectDocument> => {
    const formData = new FormData();
    formData.append('file', file);
    // Use raw fetch + absolute URL to bypass Next.js proxy entirely.
    // DO NOT set Content-Type — let the browser automatically set
    // "multipart/form-data; boundary=XXXX" with the correct boundary parameter.
    // Setting it manually (without boundary) breaks multer on the backend.
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const res = await fetch(
      `${apiBase}/crossmodel/projects/${projectId}/documents`,
      {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw { response: { data: err } };
    }
    return res.json();
  },

  /** Add a URL to a project's knowledge base (analyzed by CrossModel) */
  addUrlToProject: async (projectId: string, url: string, name?: string): Promise<ProjectDocument> => {
    const response = await apiClient.post(`/crossmodel/projects/${projectId}/documents/url`, {
      url,
      name,
    });
    return response.data;
  },

  /** Add a Gmail attachment to a project's knowledge base (ticket 99145890).
   *  Server fetches the attachment by messageId + filename (the same download
   *  path gmail_get_attachment uses), extracts text (vision hop for images)
   *  and ingests it. Deduped by messageId+filename: a repeat add returns
   *  { duplicate: true } with the existing document id. */
  addGmailAttachmentToProject: async (
    projectId: string,
    messageId: string,
    filename: string,
    label?: string,
  ): Promise<ProjectDocument & { duplicate?: boolean }> => {
    const response = await apiClient.post(`/crossmodel/projects/${projectId}/documents/gmail-attachment`, {
      messageId,
      filename,
      label,
    });
    return response.data;
  },

  /** Delete a document + all its chunks */
  deleteDocument: async (docId: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/documents/${docId}`);
  },

  /** Poll document processing status */
  getStatus: async (docId: string): Promise<{ status: string; chunkCount: number; errorMsg?: string }> => {
    const response = await apiClient.get(`/crossmodel/documents/${docId}/status`);
    return response.data;
  },
};

// ── Chat Files API (per-chat persisted uploads — ticket 57ef1b9f) ───────────
//
// ChatFiles are durable copies of user UPLOADS (backend PR1, 2026-08-25):
// GET /chats/:chatId/files returns metadata (never the bytes); the two byte
// routes are Bearer-only (NO query-token variant, unlike generated-files), so
// download + inline preview MUST ride an explicit Authorization header — the
// raw fetch + Bearer → blob → objectURL pattern of filesApi.downloadGenerated.

export interface ChatFileMeta {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploadId: string | null;
}

/** Absolute byte-API base (bypasses the Next.js proxy, same as upload/download). */
const chatFilesApiBase = () => process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

export const chatFilesApi = {
  /** List the chat's persisted uploads (metadata only, newest first). */
  listForChat: async (chatId: string): Promise<ChatFileMeta[]> => {
    const response = await apiClient.get(`/crossmodel/chats/${chatId}/files`);
    return response.data.data?.files || [];
  },

  /** List the caller's uploads across ALL chats (the global Files page's Chat
      uploads section). Rows carry chatId so the page can link to the source chat. */
  listAll: async (): Promise<(ChatFileMeta & { chatId: string })[]> => {
    const response = await apiClient.get('/crossmodel/chat-uploads');
    return response.data.data?.files || [];
  },

  /** Delete one upload (uploader only — 404 otherwise). */
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/files/${id}`);
  },

  /** Absolute download URL (attachment) — needs a Bearer fetch, not a bare <a href>. */
  downloadUrl: (fileId: string): string =>
    `${chatFilesApiBase()}/crossmodel/files/${fileId}/download`,

  /** Absolute inline URL (image/*, application/pdf, text/*, audio/* — 415 otherwise). */
  inlineUrl: (fileId: string): string =>
    `${chatFilesApiBase()}/crossmodel/files/${fileId}/inline`,

  /**
   * Extracted TEXT for the in-panel preview modal (docx/xlsx/pdf/txt/md…).
   * This is a TEXT route (never bytes) — the /inline byte allowlist stays the
   * stored-XSS guard it is. Raw fetch + Bearer like the byte routes.
   */
  previewText: async (id: string): Promise<{ text: string; truncated: boolean }> => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const res = await fetch(`${chatFilesApiBase()}/crossmodel/files/${id}/preview-text`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw { response: { data: err } };
    }
    const body = await res.json();
    return body.data || { text: '', truncated: false };
  },

  /** Download a chat file (raw fetch + Bearer, same pattern as filesApi.downloadGenerated). */
  download: async (id: string, filename: string): Promise<void> => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const res = await fetch(chatFilesApi.downloadUrl(id), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw { response: { data: err } };
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  /**
   * Inline preview in a new tab. The inline route is Bearer-only, so a plain
   * window.open(url) would 401 — fetch the bytes, then open the object URL.
   * The tab is opened synchronously (popup blockers kill window.open after an
   * await); the object URL is revoked on a delay so the tab can finish loading.
   */
  openInline: async (id: string): Promise<void> => {
    const tab = typeof window !== 'undefined' ? window.open('', '_blank') : null;
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    try {
      const res = await fetch(chatFilesApi.inlineUrl(id), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw { response: { data: err } };
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (tab) {
        tab.location.href = url;
      } else {
        window.open(url, '_blank');
      }
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      tab?.close();
      throw e;
    }
  },
};

// ── Worktree API (Phase-1 read-only worktree tree + inline viewer — ticket 999e3dbe) ──
//
// GET /chats/:chatId/worktree/tree lists ONE directory level of the chat's
// coding worktree (dirs before files, git-status badge letters; .git +
// node_modules never listed, .gitignore respected unless showIgnored=1).
// GET /chats/:chatId/worktree/file reads one UTF-8 text file (≤256 KB) for the
// inline read-only viewer. Errors: 400 dir/bad path, 404 no worktree/missing
// file, 413 too large, 415 binary.
//
// NOTE: unlike most crossmodel routes these two return their payload DIRECTLY
// (no { success, data } envelope — see backend worktree-files.ts), so the
// helpers return response.data itself. Error bodies are { error: string } and
// reach callers as axios errors (e?.response?.status / e?.response?.data?.error).

export interface WorktreeTreeEntry {
  name: string;
  /** Worktree-relative path (forward slashes) — the key for expand + file fetches. */
  path: string;
  type: 'file' | 'dir';
  size?: number;
  /** Last-modified time (epoch ms) for files AND dirs — shown in the row and
   *  used by the "recent first" sort. Absent for a tracked file gone from disk. */
  mtime?: number;
  /** Git badge letter vs HEAD: M modified, A added, D deleted-from-disk, ? untracked. */
  status?: 'M' | 'A' | 'D' | '?';
}

export interface WorktreeTreeResponse {
  path: string;
  entries: WorktreeTreeEntry[];
  /** True when the backend capped the level (5000 entries) — the tail is not shown. */
  truncated?: boolean;
}

export interface WorktreeFileResponse {
  path: string;
  content: string;
  truncated: boolean;
  /** True when the bytes came live from the box hosting the worktree (not the shared snapshot). */
  live?: boolean;
}

/** One lazy directory level of the chat's worktree ('' = the worktree root). */
export async function getWorktreeTree(chatId: string, path = '', showIgnored = false): Promise<WorktreeTreeResponse> {
  const response = await apiClient.get(`/crossmodel/chats/${chatId}/worktree/tree`, {
    params: { path, showIgnored: showIgnored ? '1' : '0' },
  });
  return response.data;
}

/** One UTF-8 text file (≤256 KB) from the chat's worktree, for the inline viewer. */
export async function getWorktreeFile(chatId: string, path: string): Promise<WorktreeFileResponse> {
  const response = await apiClient.get(`/crossmodel/chats/${chatId}/worktree/file`, {
    params: { path },
  });
  return response.data;
}

/**
 * Ticket 19fbd876: download a worktree file's REAL BYTES (binary included) —
 * the raw-fetch + Bearer → blob → objectURL pattern of filesApi.downloadGenerated
 * (the route sets Content-Disposition, but the explicit filename wins on the
 * anchor). Serves disk → shared snapshot → live cross-box read, 16 MB cap.
 */
export async function downloadWorktreeFile(chatId: string, path: string, filename?: string): Promise<void> {
  const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
  const token = typeof window !== 'undefined' ? window.localStorage.getItem('accessToken') : null;
  const res = await fetch(
    `${apiBase}/crossmodel/chats/${chatId}/worktree/raw?path=${encodeURIComponent(path)}`,
    { headers: token ? { Authorization: `Bearer ${token}` } : {} }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw { response: { data: err } };
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || path.split('/').pop() || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Grouped form mirroring the module's *Api idiom (same two functions). */
export const worktreeApi = {
  tree: getWorktreeTree,
  file: getWorktreeFile,
  download: downloadWorktreeFile,
};

// ── Profile API ───────────────────────────────────────────────────────────────

export const profileApi = {
  consolidate: async (): Promise<{ facts: Record<string, string>; consolidated: number; message: string }> => {
    const response = await apiClient.post('/crossmodel/memory/consolidate');
    return {
      facts: response.data.data?.facts || {},
      consolidated: response.data.data?.consolidated || 0,
      message: response.data.message || '',
    };
  },
};

// ── Canvas API ────────────────────────────────────────────────────────────────

export interface CanvasDocumentSummary {
  id: string;
  title: string;
  type: string;
  language?: string | null;
  version: number;
  content: string;  // included so canvas panel can be restored when reopening a chat
  createdAt: string;
  updatedAt: string;
}

export interface CanvasDocumentFull extends CanvasDocumentSummary {
  chatId: string;
  userId: string;
}

export interface CanvasDocumentWithChat extends CanvasDocumentFull {
  chat: {
    id: string;
    title: string;
    projectId: string | null;
    project: { id: string; name: string; emoji: string | null } | null;
  };
}

export const canvasApi = {
  /** List all canvases for a chat (includes content for panel restore) */
  listForChat: async (chatId: string): Promise<CanvasDocumentSummary[]> => {
    const response = await apiClient.get(`/crossmodel/chats/${chatId}/canvases`);
    return response.data.data || [];
  },

  /** List ALL canvases for the user across all chats (for Files section) */
  listAll: async (): Promise<CanvasDocumentWithChat[]> => {
    const response = await apiClient.get('/crossmodel/canvases');
    return response.data.data || [];
  },

  /** Get a single canvas with full content */
  get: async (id: string): Promise<CanvasDocumentFull> => {
    const response = await apiClient.get(`/crossmodel/canvases/${id}`);
    return response.data.data;
  },

  /** Create a new canvas manually */
  create: async (chatId: string, data: {
    title: string;
    type?: string;
    language?: string;
    content: string;
  }): Promise<CanvasDocumentFull> => {
    const response = await apiClient.post(`/crossmodel/chats/${chatId}/canvases`, data);
    return response.data.data;
  },

  /** Update canvas content and/or title */
  update: async (id: string, data: {
    content?: string;
    title?: string;
    language?: string;
  }): Promise<CanvasDocumentFull> => {
    const response = await apiClient.put(`/crossmodel/canvases/${id}`, data);
    return response.data.data;
  },

  /** Delete a canvas */
  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/canvases/${id}`);
  },

  // ── Public sharing: the artifact becomes a real web page ANYONE can open ──
  share: async (id: string): Promise<{ shareToken: string; url: string }> => {
    const response = await apiClient.post(`/crossmodel/canvases/${id}/share`);
    return response.data.data;
  },
  shareStatus: async (id: string): Promise<{ shared: boolean; shareToken?: string; url?: string }> => {
    const response = await apiClient.get(`/crossmodel/canvases/${id}/share`);
    return response.data.data;
  },
  revokeShare: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/canvases/${id}/share`);
  },
};

// ── Preferences API ───────────────────────────────────────────────────────────

export type ModelSet = 'frontier' | 'open_source';

export interface UserPrefs {
  modelSet: ModelSet;
  /** 'glm-5.2' can still surface from prefs stored before the GLM-5.3 cutover (2026-09-03);
   *  'deepseek-v4-pro' from before the DeepSeek V4.1 Flash cutover (2026-09-10 — the
   *  server maps it to 'deepseek-flash' on read). */
  codingModel?: 'glm-5.3' | 'deepseek-flash' | 'kimi-k3' | 'glm-5.2' | 'deepseek-v4-pro';
  /** Seats govern sessions (2026-09-28): true when the stored codingModel is a pick the user
   *  made THEMSELVES (Account → Coding save / set_preferences); false = the admin's Workspace
   *  default seat governs their sessions. Absent on a pre-change backend. */
  codingModelExplicit?: boolean;
  /** What the Workspace default (coding_default) seat resolves to right now. */
  codingSeatModel?: string;
  codingPermissionMode?: 'auto' | 'plan' | 'ask';
  /** Shared tailnet dev container (Account → Coding; admin-only v1). */
  devContainerEnabled?: boolean;
}

export const preferencesApi = {
  /** Get the user's preferences (chat model set + coding settings). */
  get: async (): Promise<UserPrefs> => {
    const response = await apiClient.get('/crossmodel/preferences');
    return response.data.data;
  },

  /** Update the chat model set preference. */
  update: async (modelSet: ModelSet): Promise<UserPrefs> => {
    const response = await apiClient.put('/crossmodel/preferences', { modelSet });
    return response.data.data;
  },

  /** Update Digby Code settings (open-source model + default permission mode).
   *  codingModel also accepts a '<label>:<modelId>' custom endpoint spec
   *  (Digby Edge registry — validated server-side). */
  updateCoding: async (body: {
    codingModel?: 'glm-5.3' | 'deepseek-flash' | 'kimi-k3' | (string & {});
    codingPermissionMode?: 'auto' | 'plan' | 'ask';
    devContainerEnabled?: boolean;
  }): Promise<UserPrefs> => {
    const response = await apiClient.put('/crossmodel/preferences', body);
    return response.data.data;
  },
};

// ── Images API (image generation — the Image generator seat, 2026-09-24) ─────
//
// POST /crossmodel/images/generate mirrors the chat's generate_image tool: the
// backend runs the seat (DashScope Qwen/Wan/Z-Image, Z.AI GLM-Image/CogView,
// or an [image]-flagged custom endpoint), stores the bytes ONCE as a
// GeneratedFile and answers with the file id + the two byte routes. No UI
// caller in v1 beyond scripts / the Mac app / future composer use — the
// transcript and the Files sidebar render generated images from the file id.

export type ImageAspect = 'square' | 'landscape' | 'portrait' | 'wide' | 'tall';

export interface GenerateImageRequest {
  /** Full image prompt, 3–2000 characters. */
  prompt: string;
  /** Shape (default square ≈1024×1024; landscape 4:3, portrait 3:4, wide 16:9, tall 9:16). */
  aspect?: ImageAspect;
  /** Optional style hint appended to the prompt (≤200 chars). */
  style?: string;
  /** Let the provider expand/rewrite the prompt for richer detail (slower). */
  polish?: boolean;
  /** Things to avoid (≤500 chars; DashScope models only). */
  negativePrompt?: string;
  /** uploadId of an attached image to edit / re-style. */
  referenceUploadId?: string;
  /** File id of an earlier generated image to edit / re-style. */
  referenceFileId?: string;
  /** Attribute the file to one of the caller's own chats (Files sidebar). */
  chatId?: string;
}

export interface GenerateImageResult {
  success: boolean;
  fileId: string;
  filename: string;
  mimeType: string;
  width?: number;
  height?: number;
  /** Decoded byte size. */
  size: number;
  model: string;
  provider: 'dashscope' | 'zai' | 'custom' | string;
  /** 'native' = the reference image rode along as image input; 'described' =
   *  it was described by the Image reader seat and folded into the prompt. */
  referenceMode: 'none' | 'native' | 'described';
  latencyMs: number;
  /** Relative byte routes (prefix with the API origin for a raw fetch). */
  inlineUrl: string;
  downloadUrl: string;
}

/**
 * Error body shapes the endpoint answers with, keyed by status:
 *   429 { error: 'rate_limited', scope: 'chat_hourly' | 'user_daily', cap }
 *   413 { error: 'quota', message }   422 { error: 'refused', message }
 *   503 { error: 'unconfigured', message } (names the seat page + env var)
 *   502 { error: 'Image generation failed', details }
 * apiClient rejects with the axios error — read `err.response.data`.
 */
export interface GenerateImageErrorBody {
  error: string;
  message?: string;
  details?: string;
  scope?: 'chat_hourly' | 'user_daily';
  cap?: number;
}

export const imagesApi = {
  generate: async (body: GenerateImageRequest): Promise<GenerateImageResult> => {
    const response = await apiClient.post('/crossmodel/images/generate', body);
    return response.data;
  },
};

// ── Voice API (transcription + TTS) ──────────────────────────────────────────

export const voiceApi = {
  /**
   * Transcribe audio using OpenAI Whisper.
   * @param audio  base64-encoded audio data
   * @param mimeType  MIME type of the audio (e.g. 'audio/webm')
   * @param filename  optional filename hint for Whisper
   * @returns the transcribed text
   */
  transcribe: async (audio: string, mimeType: string, filename?: string): Promise<string> => {
    const response = await apiClient.post('/crossmodel/transcribe', {
      audio,
      mimeType,
      filename: filename || 'recording.webm',
    });
    return response.data.text || '';
  },

  /**
   * Convert text to speech using OpenAI TTS-1.
   * @param text  text to speak (will be truncated to 4096 chars server-side)
   * @param voice  optional voice name (default: 'nova')
   * @returns base64 MP3 audio and its MIME type
   */
  tts: async (text: string, voice?: string): Promise<{ audio: string; mimeType: string }> => {
    const response = await apiClient.post('/crossmodel/tts', { text, voice });
    return { audio: response.data.audio, mimeType: response.data.mimeType };
  },

  /**
   * Progressive text-to-speech (ticket 2774d2b7 — "text to speech button
   * doesn't work at all, just spins and dies").
   *
   * Root cause: read-aloud used tts() above — ONE request that synthesized
   * the whole answer server-side (~14 s per ≤600-char chunk, sequential, so
   * 50-130 s for a multi-paragraph answer) while the shared axios client
   * times out at API_TIMEOUT_MS (45 s). axios aborted, the spinner stopped,
   * and a toast said "Text-to-speech failed" with no audio ever playing.
   *
   * This streams POST /crossmodel/tts/stream (NDJSON, one line per synthesized
   * chunk) with raw fetch — the ONLY client bound is a 55 s IDLE timeout
   * between lines (each chunk line or 20 s server keepalive ping resets it),
   * not a total-request cap: the first chunk plays in seconds and the rest
   * synthesize while it plays.
   *
   * @param onChunk  called per chunk in ARRIVAL order (a chunk is ready to
   *                 play as soon as it arrives — but chunks must be PLAYED/
   *                 concatenated by `index`, text order)
   * @param signal   aborts the stream (the stop button) — rejects with the
   *                 AbortError once in flight
   * @returns the terminal "done" line (delivered/model/voice) or, when the
   *          stream ended mid-answer, the "error" line
   */
  ttsStream: async (
    text: string,
    voice: string | undefined,
    onChunk: (chunk: { index: number; total: number; mimeType: string; audio: string }) => void,
    signal?: AbortSignal,
  ): Promise<{ delivered: number; model: string; voice: string; mimeType: string } | { error: string; partial?: boolean }> => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    // ONE internal controller both the caller's abort and the idle timer fire —
    // it must own the fetch from the start so either one cancels the body read.
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', onCallerAbort);
    // Idle timeout between LINES: one chunk can take ~15-40 s on a slow vendor
    // day and the server pings every 20 s, so 55 s of TOTAL silence means the
    // stream is dead — abort rather than spin forever (the exact symptom this
    // ticket reports). Every line resets it.
    const IDLE_TIMEOUT_MS = 55_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
    };
    resetIdle();
    try {
      const res = await fetch(`${apiBase}/crossmodel/tts/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ text, voice }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        // e.g. 400 empty text / 401 — a real terminal failure, not a stall.
        let message = `TTS stream failed (HTTP ${res.status})`;
        try { const j = await res.json(); if (j?.error) message = j.error; } catch { /* not JSON */ }
        return { error: message };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let terminal: { delivered: number; model: string; voice: string; mimeType: string } | { error: string; partial?: boolean } | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let obj: any;
          try { obj = JSON.parse(line); } catch { continue; } // a torn line is skipped, never fatal
          if (obj?.type === 'chunk' && typeof obj.index === 'number' && typeof obj.audio === 'string') {
            onChunk({ index: obj.index, total: obj.total, mimeType: obj.mimeType, audio: obj.audio });
          } else if (obj?.type === 'done') {
            terminal = { delivered: obj.delivered, model: obj.model, voice: obj.voice, mimeType: obj.mimeType };
          } else if (obj?.type === 'error') {
            terminal = { error: String(obj.message || 'Text-to-speech failed'), partial: !!obj.partial };
          }
          // ping lines just reset the idle timer (handled above for every byte)
        }
      }
      return terminal ?? { error: 'TTS stream ended without audio' };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener('abort', onCallerAbort);
    }
  },
};

// ── Feedback API ──────────────────────────────────────────────────────────────

export type FeedbackType = 'thumbs_down' | 'thumbs_up' | 'report';
export type FeedbackReason = 'wrong' | 'harmful' | 'slow' | 'formatting' | 'incomplete' | 'other';

export interface FeedbackPayload {
  messageId?: string;
  chatId: string;
  type: FeedbackType;
  reason?: FeedbackReason;
  comment?: string;
  modelSet?: 'frontier' | 'open_source';
}

export const feedbackApi = {
  /**
   * Submit feedback on an AI response.
   *
   * The /feedback endpoint uses optionalAuthenticate (never returns 401), so
   * apiClient's 401-retry interceptor won't trigger a token refresh.  We
   * proactively refresh the access token before submitting to ensure the user
   * is identified and a user_feature_requests entry is created (visible in
   * Account → Feedback).
   *
   * Falls back to anonymous submission if refresh fails — feedback is never
   * lost, but won't appear in the Feedback tab.
   */
  submit: async (payload: FeedbackPayload): Promise<{ id: string; featureRequestId?: string }> => {
    // Proactively refresh the access token so the user is always identified.
    // The /feedback endpoint uses optionalAuthenticate which silently ignores
    // expired tokens (instead of returning 401), so apiClient's auto-retry
    // interceptor would never kick in.
    try {
      const { data: refreshData } = await apiClient.post('/auth/refresh', {});
      if (refreshData?.data?.accessToken) {
        localStorage.setItem('accessToken', refreshData.data.accessToken);
      }
    } catch {
      // Refresh failed — continue with whatever token we have (or none)
    }

    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
    const res = await fetch(`${apiBase}/crossmodel/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error('Failed to submit feedback');
    const data = await res.json();
    return { id: data.id, featureRequestId: data.featureRequestId ?? undefined };
  },
};

// ── Feature Request API ───────────────────────────────────────────────────────

export type FeatureRequestType = 'feature_request' | 'bug_report' | 'general_feedback' | 'mishap' | 'enhancement' | 'research_idea';
// 6665fff6 lifecycle states flow to the tab from the shared table — the
// union must cover them or TS narrows them out of the bucket filters above.
export type FeatureRequestStatus = 'open' | 'in_progress' | 'done' | 'awaiting_verification' | 'deployed_verified' | 'reopened';

export interface FeatureRequestCounts {
  total: number;
  open: number;
  in_progress: number;
  done: number;
  resolved: number;
  // 6665fff6 lifecycle states (the backend counts endpoint emits these keys —
  // crossmodel.controller.ts folds byStatus groups through normalizeTicketStatus).
  awaiting_verification?: number;
  deployed_verified?: number;
  reopened?: number;
  queued?: number;
  bySource: { user: number; agent: number };
}

export interface FeatureRequestListResult {
  requests: FeatureRequest[];
  counts?: FeatureRequestCounts;
  /** true when the user has more tickets than the fetched page (older ones not returned). */
  truncated?: boolean;
}

export interface FeatureRequest {
  id: string;
  userId: string | null;      // null for agent-filed tickets from anonymous runs
  type: FeatureRequestType;
  title: string;
  description: string;
  status: FeatureRequestStatus;
  priority: number;
  adminNote?: string | null;  // Digby's response: what was done, why, or ETA
  source?: 'user' | 'agent';  // 'agent' = filed by an agent run (file_feedback tool)
  occurrences?: number;       // dedup sighting count (>1 = recurring ticket)
  updatedAt?: string;
  createdAt: string;
}

export const featureRequestApi = {
  /** Submit a feature request, bug report, or general feedback */
  submit: async (data: { type: FeatureRequestType; title: string; description: string }): Promise<FeatureRequest> => {
    const response = await apiClient.post('/crossmodel/feature-request', data);
    return response.data.data;
  },

  /** List the authenticated user's own submissions (+ true per-status counts across
   *  their whole history — the array is the newest page, counts are the real totals). */
  list: async (): Promise<FeatureRequestListResult> => {
    const response = await apiClient.get('/crossmodel/feature-requests');
    return {
      requests: response.data.data || [],
      counts: response.data.counts,
      truncated: response.data.truncated,
    };
  },

  /** Let the user mark their own submission as resolved/done */
  resolve: async (id: string): Promise<FeatureRequest> => {
    const response = await apiClient.patch(`/crossmodel/feature-requests/${id}/resolve`);
    return response.data.data;
  },

  /** Admin: list ALL submissions across all users */
  adminList: async (params?: { status?: string; type?: string; limit?: number }): Promise<FeatureRequest[]> => {
    const response = await apiClient.get('/crossmodel/admin/feature-requests', { params });
    return response.data.data || [];
  },

  /** Admin: update status and/or adminNote on a submission */
  adminUpdate: async (id: string, data: { status?: string; adminNote?: string; priority?: number }): Promise<FeatureRequest> => {
    const response = await apiClient.patch(`/crossmodel/admin/feature-requests/${id}`, data);
    return response.data.data;
  },

  /** Admin: tickets the owner-only ticket-lane rule holds (another non-admin account's, not approved yet — audit 2026-10-08 W5-1a). Admin-authored tickets auto-dispatch. A degraded response withholds the list when the lane-home owner cannot be resolved. */
  adminListHeld: async (): Promise<{ tickets: HeldTicket[]; ownerResolved: boolean; degraded: boolean; error: string | null }> => {
    const response = await apiClient.get('/crossmodel/admin/feature-requests/held');
    return {
      tickets: response.data.data || [],
      ownerResolved: response.data.ownerResolved !== false,
      degraded: response.data.degraded === true,
      error: typeof response.data.error === 'string' ? response.data.error : null,
    };
  },

  /** Admin: approve (or revoke) a held ticket for an auto-merging ticket lane — audited server-side. */
  adminApproveDispatch: async (id: string, approved = true): Promise<{ id: string; adminNote: string | null }> => {
    const response = await apiClient.post(`/crossmodel/admin/feature-requests/${id}/approve-dispatch`, { approved });
    return response.data.data;
  },
};

/** A ticket held for owner review (GET /admin/feature-requests/held). */
export interface HeldTicket {
  id: string;
  type: FeatureRequestType;
  title: string;
  description: string;
  status: string;
  priority: number;
  source: 'user' | 'agent';
  createdAt: string;
  adminNote: string | null;
  userId: string | null;
  user: { email: string; name: string | null } | null;
  /** A detector-stamped framework ticket (verifier / class) rather than a person's report. */
  harness: boolean;
  /** The description is shape-only (the chat's account is not an admin). */
  subjectContentWithheld: boolean;
}

// ── Google Workspace API ──────────────────────────────────────────────────────

export interface GoogleStatus {
  connected: boolean;
  email?: string | null;
  scopes?: string[];
  label?: string;
  expiresAt?: string;
  connectedAt?: string;
}

export interface GoogleAccount {
  id: string;
  label: string;
  email?: string | null;
  scopes?: string[];
  /** Editing scopes this account still lacks (2026-09-23) — drives the "Update permissions" CTA. */
  missingWriteScopes?: string[];
  expiresAt?: string;
  connectedAt?: string;
}

export const googleApi = {
  /** Get Google connection status for the current user (first account — backward compat) */
  getStatus: async (): Promise<GoogleStatus> => {
    const response = await apiClient.get('/crossmodel/google/status');
    return response.data.data;
  },

  /** List all connected Google accounts for the current user */
  listAccounts: async (): Promise<GoogleAccount[]> => {
    const response = await apiClient.get('/crossmodel/google/accounts');
    return response.data.data || [];
  },

  /** Rename a connected Google account's display label (e.g. "Work" → "Sunday Market Media").
   *  Throws with the server's error message on 400/404/409. */
  renameAccount: async (id: string, label: string): Promise<GoogleAccount> => {
    const response = await apiClient.patch(`/crossmodel/google/accounts/${encodeURIComponent(id)}/label`, { label });
    return response.data.data;
  },

  /** Revoke Google access and delete stored token(s).
   *  If label is provided, disconnects only that account.
   *  Otherwise disconnects all accounts. */
  disconnect: async (label?: string): Promise<void> => {
    const url = label
      ? `/crossmodel/google/disconnect?label=${encodeURIComponent(label)}`
      : '/crossmodel/google/disconnect';
    await apiClient.delete(url);
  },

  /** Send a Gmail email after user confirms in the chat UI.
   *  `label` selects which connected Google account to send from (defaults to the first). */
  sendEmail: async (payload: {
    to:       string;
    subject:  string;
    body:     string;
    cc?:      string;
    bcc?:     string;
    label?:   string;
  }): Promise<{ success: boolean; messageId?: string; label?: string | null }> => {
    const response = await apiClient.post('/crossmodel/google/send-email', payload);
    return response.data;
  },
};

// ── GitHub API ─────────────────────────────────────────────────────────────────

export interface GitHubStatus {
  connected: boolean;
  username?: string | null;
  scopes?: string[];
  label?: string;
  connectedAt?: string;
}

export interface GitHubAccount {
  id: string;
  label: string;
  username?: string | null;
  scopes?: string[];
  connectedAt?: string;
}

export const githubApi = {
  getStatus: async (): Promise<GitHubStatus> => {
    const response = await apiClient.get('/crossmodel/github/status');
    return response.data.data;
  },
  listAccounts: async (): Promise<GitHubAccount[]> => {
    const response = await apiClient.get('/crossmodel/github/accounts');
    return response.data.data || [];
  },
  disconnect: async (label?: string): Promise<void> => {
    const url = label
      ? `/crossmodel/github/disconnect?label=${encodeURIComponent(label)}`
      : '/crossmodel/github/disconnect';
    await apiClient.delete(url);
  },
  // Connect via a Personal Access Token instead of the OAuth app (reliable for
  // private org repos where the OAuth app needs separate org approval).
  connectPat: async (token: string, label?: string): Promise<{ username: string | null; scopes: string[]; label: string }> => {
    const response = await apiClient.post('/crossmodel/github/pat', { token, label });
    return response.data.data;
  },
};

// ── iMessage (macOS bridge agent) API ──────────────────────────────────────────

export interface IMessageStatus {
  connected: boolean;
  online: boolean;
  deviceName?: string | null;
  agentVersion?: string | null;
  /** Ticket 31fd8440: the CURRENT released agent version (from the backend's
      release manifest) — lets the card show "update available (latest vX.Y.Z)"
      next to the per-device agentVersion, so a user can tell a stale agent
      from a current one without re-downloading. null/absent = the server does
      not know (older backend). */
  latestAgentVersion?: string | null;
  lastSeenAt?: string | null;
  pairedAt?: string | null;
  /** Browser program (UI Phase 6a, additive): the browser router's OWN
      local-driver gate (paired Mac online AND app ≥ 0.2.0) + its
      human-readable status line — what an agent browse would use right now. */
  localBrowser?: { available: boolean; status: string };
  /** Computer use (2026-09-09, additive): the computer-agent's OWN availability
      gate (paired Mac online AND app ≥ 0.3.0 AND vision configured) + its
      status line — whether Digby can see and drive the user's actual screen. */
  computerUse?: { available: boolean; status: string };
  /** Multi-Mac (2026-09-24, additive): ALL paired Macs with per-device
      presence + capabilities, and the default routing target's id. The
      legacy aggregate fields above describe the DEFAULT Mac only. */
  agents?: IMessageAgentInfo[];
  defaultAgentId?: string | null;
}

/** One paired Mac in the /status and /agents payloads (multi-Mac, 2026-09-24). */
export interface IMessageAgentInfo {
  id: string;
  label: string;
  deviceId?: string | null;
  deviceName?: string | null;
  /** The display name: label if set, else the pair-time hostname. */
  name?: string | null;
  isDefault?: boolean;
  agentVersion?: string | null;
  /** Agent-advertised OS ('macos' | 'windows'); absent = a legacy Mac row. */
  platform?: string | null;
  online: boolean;
  lastSeenAt?: string | null;
  pairedAt?: string | null;
  localBrowser?: { available: boolean; status: string };
  computerUse?: { available: boolean; status: string };
  /** Agent-advertised macOS TCC permission state (ticket 2f646c10, agent ≥
      0.6.0): Accessibility / Screen Recording / Full Disk Access granted, and
      whether the helper needs a relaunch (post-update ghost-grant self-heal).
      null = a legacy agent never advertised — the card shows the update hint. */
  permissions?: { ax: boolean; sr: boolean; fda: boolean; relaunch: boolean; cal?: boolean } | null;
  /** The "Unattended / Autonomous use" preset (2026-10-28): will this device
      still have a live session when the fleet wants it, and if not the ONE
      setting to change. Additive — absent on an older backend.
      Ticket 11b6974f: `state` is the typed four-state line (`ready` /
      `blocked` / `off` / `unavailable`) so a consumer can tell a deliberate
      "the owner has not enabled it" (`off`) from "this agent build cannot
      report it" (`unavailable`); `enabled:false` alone conflated the two. */
  unattendedReady?: {
    state?: 'ready' | 'blocked' | 'off' | 'unavailable';
    enabled: boolean;
    ready: boolean;
    reason: string;
    /** TICKET 36d1c99f: the RAW blocker tokens in priority order ([] when
        ready/off/unavailable). The guided enable flow branches on
        `blockers.includes('filevault')` — auto-login cannot coexist with
        FileVault, so the tradeoff must be named BEFORE any privileged step.
        Absent on an older backend → treat as unknown, never as "no FileVault". */
    blockers?: string[];
  };
  /** PRE-LOGIN INPUT (ticket c468f922): can input be delivered while no user
      session exists (`status` — 'unavailable' in this build, no privileged
      helper ships), and is the console at a lock/login screen RIGHT NOW
      (`blockedNow`). This is the fact a dispatcher refuses on. */
  prelogin?: { status: 'available' | 'unavailable'; blockedNow: boolean; reason: string };
  /** BROKERED REMOTE ACCESS (ticket c468f922, owner ruling 2026-10-29) — a
      SEPARATE fact from `prelogin`: whether a hardened OPERATOR channel (macOS
      Screen Sharing / Windows RDP, tunnel-scoped) exists. `state` is the
      three-state health line; `off` is the healthy default, NOT a fault. */
  remoteAccess?: {
    state: 'off' | 'on' | 'blocked' | 'unavailable';
    enabled: boolean;
    tunnelOnly: boolean;
    ready: boolean;
    reason: string;
  };
}

export interface IMessageChat {
  chatId: number;
  guid?: string;
  identifier: string;          // phone number or email
  displayName?: string | null;
  lastMessage?: string | null;
  lastDate?: string | null;
}

export interface IMessageMessage {
  id: number;
  text: string;
  fromMe: boolean;
  handle?: string | null;
  date?: string | null;
}

export const imessageApi = {
  getStatus: async (opts?: { signal?: AbortSignal }): Promise<IMessageStatus> => {
    const response = await apiClient.get('/crossmodel/imessage/status', { signal: opts?.signal });
    return response.data.data;
  },
  listAgents: async (): Promise<IMessageAgentInfo[]> => {
    const response = await apiClient.get('/crossmodel/imessage/agents');
    return response.data.data || [];
  },
  startPairing: async (): Promise<{ pairingCode: string; expiresInSec: number }> => {
    const response = await apiClient.post('/crossmodel/imessage/pair/start');
    return response.data.data;
  },
  disconnect: async (): Promise<void> => {
    await apiClient.delete('/crossmodel/imessage/disconnect');
  },
  /** Multi-Mac (2026-09-24): unpair ONE Mac by id. */
  disconnectAgent: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/imessage/agents/${encodeURIComponent(id)}`);
  },
  /** Multi-Mac: rename a Mac (its display label). */
  renameAgent: async (id: string, label: string): Promise<{ id: string; label: string }> => {
    const response = await apiClient.patch(`/crossmodel/imessage/agents/${encodeURIComponent(id)}`, { label });
    return response.data.data;
  },
  /** Multi-Mac: make a Mac the default routing target. */
  setDefaultAgent: async (id: string): Promise<{ id: string; isDefault: boolean }> => {
    const response = await apiClient.post(`/crossmodel/imessage/agents/${encodeURIComponent(id)}/default`);
    return response.data.data;
  },
  /** Permission onboarding (ticket 2f646c10, agent ≥ 0.6.0): relaunch the
   *  helper (post-update TCC self-heal), open a Privacy & Security pane, or
   *  reveal the DigbyHelper binary in Finder. */
  permissionAction: async (
    agentId: string,
    action: 'relaunch' | 'open-pane' | 'reveal',
    pane?: 'accessibility' | 'screen-recording' | 'full-disk-access' | 'calendars',
  ): Promise<unknown> => {
    const response = await apiClient.post(`/crossmodel/imessage/agents/${encodeURIComponent(agentId)}/permission-action`, {
      action,
      ...(pane ? { pane } : {}),
    });
    return response.data.data;
  },
  getChats: async (limit = 20, device?: string): Promise<IMessageChat[]> => {
    const q = device ? `&device=${encodeURIComponent(device)}` : '';
    const response = await apiClient.get(`/crossmodel/imessage/chats?limit=${limit}${q}`);
    return response.data.data || [];
  },
  getMessages: async (chat: string, limit = 25, device?: string): Promise<IMessageMessage[]> => {
    const q = device ? `&device=${encodeURIComponent(device)}` : '';
    const response = await apiClient.get(
      `/crossmodel/imessage/messages?chat=${encodeURIComponent(chat)}&limit=${limit}${q}`,
    );
    return response.data.data || [];
  },
  /** `opts.decisionId` (E5, 2026-09-25): the confirm card's parked send-intent decision — Send labels it confirmed (telemetry only). */
  send: async (to: string, text: string, device?: string, opts?: { decisionId?: string }): Promise<{ sent: boolean; to?: string; device?: string }> => {
    const response = await apiClient.post('/crossmodel/imessage/send', { to, text, ...(device ? { device } : {}), ...(opts?.decisionId ? { decisionId: opts.decisionId } : {}) });
    return response.data.data;
  },
  /** The confirm card was dismissed without a send — labels the parked send-intent decision declined (telemetry only). */
  draftOutcome: async (decisionId: string, outcome: 'declined'): Promise<{ recorded: boolean }> => {
    const response = await apiClient.post('/crossmodel/imessage/draft-outcome', { decisionId, outcome });
    return response.data.data;
  },
};

// ── X (Twitter) API ───────────────────────────────────────────────────────────

export interface XStatus {
  connected: boolean;
  label?: string;
  screenName?: string | null;
  scopes?: string[];
  connectedAt?: string;
  tokenExpiresAt?: string;
  /** Platform read-path health (fa956f09): null until the first X read call records an outcome. */
  readHealth?: {
    status: 'ok' | 'fail';
    lastError: string | null;
    lastErrorAt: string | null;
    failureCount: number;
  } | null;
}

export interface XAccount {
  id: string;
  label: string;
  screenName: string | null;
  scopes: string[];
  connectedAt: string;
  tokenExpiresAt: string;
}

export const xApi = {
  getStatus: async (): Promise<XStatus> => {
    const response = await apiClient.get('/crossmodel/x/status');
    return response.data.data;
  },
  listAccounts: async (): Promise<XAccount[]> => {
    const response = await apiClient.get('/crossmodel/x/accounts');
    return response.data.data || [];
  },
  disconnect: async (label?: string): Promise<void> => {
    const url = label
      ? `/crossmodel/x/disconnect?label=${encodeURIComponent(label)}`
      : '/crossmodel/x/disconnect';
    await apiClient.delete(url);
  },
};

// ── Xero API ──────────────────────────────────────────────────────────────────

export interface XeroStatus {
  connected: boolean;
  configured?: boolean;
  orgName?: string | null;
  label?: string;
  scopes?: string[];
  expiresAt?: string;
  connectedAt?: string;
}

export interface XeroAccount {
  id: string;
  label: string;
  orgName?: string | null;
  scopes?: string[];
  expiresAt?: string;
  connectedAt?: string;
}

export const xeroApi = {
  /** Get Xero connection status for the current user (first account — backward compat) */
  getStatus: async (): Promise<XeroStatus> => {
    const response = await apiClient.get('/crossmodel/xero/status');
    return response.data.data;
  },

  /** List all connected Xero accounts for the current user (ticket 64a25e8d — Google parity) */
  listAccounts: async (): Promise<XeroAccount[]> => {
    const response = await apiClient.get('/crossmodel/xero/accounts');
    return response.data.data || [];
  },

  /** Rename a connected Xero account's display label.
   *  Throws with the server's error message on 400/404/409. */
  renameAccount: async (id: string, label: string): Promise<XeroAccount> => {
    const response = await apiClient.patch(`/crossmodel/xero/accounts/${encodeURIComponent(id)}/label`, { label });
    return response.data.data;
  },

  /** Disconnect Xero account(s).
   *  If label is provided, disconnects only that account.
   *  Otherwise disconnects all accounts (backward compat). */
  disconnect: async (label?: string): Promise<void> => {
    const url = label
      ? `/crossmodel/xero/disconnect?label=${encodeURIComponent(label)}`
      : '/crossmodel/xero/disconnect';
    await apiClient.delete(url);
  },
};

// ── Plaid API ─────────────────────────────────────────────────────────────────

export interface PlaidStatus {
  connected: boolean;
  configured?: boolean;
  institutions: Array<{
    name: string;
    id?: string;
    connectedAt?: string;
  }>;
}

export const plaidApi = {
  /** Get Plaid connection status for the current user */
  getStatus: async (): Promise<PlaidStatus> => {
    const response = await apiClient.get('/crossmodel/plaid/status');
    return response.data.data;
  },

  /** Create a Plaid Link token for the frontend widget */
  createLinkToken: async (): Promise<string> => {
    const response = await apiClient.post('/crossmodel/plaid/link-token');
    return response.data.data.linkToken;
  },

  /** Exchange public_token from Plaid Link for access_token */
  exchangeToken: async (publicToken: string, institutionId?: string, institutionName?: string): Promise<void> => {
    await apiClient.post('/crossmodel/plaid/exchange', { publicToken, institutionId, institutionName });
  },

  /** Disconnect all Plaid accounts */
  disconnect: async (): Promise<void> => {
    await apiClient.delete('/crossmodel/plaid/disconnect');
  },
};

// ── Slack API ──────────────────────────────────────────────────────────────────

export interface SlackStatus {
  connected: boolean;
  configured?: boolean;
  teamName?: string | null;
  label?: string | null;
  scopes?: string[];
  connectedAt?: string | null;
  /** Ticket 24541fb3: user-token scopes the DM/group-DM read path needs but the
   *  stored token LACKS (im:history / mpim:history). Non-empty = reconnect to gain
   *  them (Slack appends scopes on re-auth; it never removes existing ones). */
  missingScopes?: string[];
}

export const slackApi = {
  /** Get Slack connection status for the current user */
  getStatus: async (): Promise<SlackStatus> => {
    const response = await apiClient.get('/crossmodel/slack/status');
    return response.data.data;
  },

  /** Disconnect Slack workspace(s) */
  disconnect: async (): Promise<void> => {
    await apiClient.delete('/crossmodel/slack/disconnect');
  },
};

// ── Asana API ──────────────────────────────────────────────────────────────────

export interface AsanaStatus {
  connected: boolean;
  configured?: boolean;
  asanaName?: string | null;
  label?: string | null;
  connectedAt?: string | null;
}

export const asanaApi = {
  /** Get Asana connection status for the current user */
  getStatus: async (): Promise<AsanaStatus> => {
    const response = await apiClient.get('/crossmodel/asana/status');
    return response.data.data;
  },

  /** Disconnect Asana account */
  disconnect: async (): Promise<void> => {
    await apiClient.delete('/crossmodel/asana/disconnect');
  },
};

// ── Telegram API ─────────────────────────────────────────────────────────────

export interface TelegramStatus {
  connected: boolean;
  configured?: boolean;
  botUsername?: string | null;
  username?: string | null;
  firstName?: string | null;
  connectedAt?: string | null;
}

export const telegramApi = {
  /** Get Telegram connection status for the current user */
  getStatus: async (): Promise<TelegramStatus> => {
    const response = await apiClient.get('/crossmodel/telegram/status');
    return response.data.data;
  },

  /** Mint a one-time t.me deep link to connect Telegram */
  getConnectLink: async (): Promise<string> => {
    const response = await apiClient.post('/crossmodel/telegram/connect-link');
    return response.data.data.url;
  },

  /** Disconnect Telegram */
  disconnect: async (): Promise<void> => {
    await apiClient.delete('/crossmodel/telegram/disconnect');
  },
};

// ── Deep Research Quota API ───────────────────────────────────────────────

export interface DeepResearchQuota {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
  authenticated: boolean;
  /** The server's `patience_auto_only` switch (2026-09-26): every explicit
   *  preset on a human send is routed as Auto while true — an explicit client
   *  preset is recorded as the requested depth and does not pick the run.
   *  (The web app stopped reading this when the Advanced tab was removed,
   *  c99b404a 2026-10-27.) Absent on a legacy backend (⇒ not locked). */
  autoOnly?: boolean;
}

export const deepResearchApi = {
  /** Get the user's remaining deep_research quota for today */
  getQuota: async (): Promise<DeepResearchQuota> => {
    const response = await apiClient.get('/crossmodel/deep-research/quota');
    return response.data.data;
  },
};

// ── Depth policy (the always-Auto switch, user-facing; audit 2026-09-26) ──

/** GET /depth/policy — `autoOnly` true = every human send is routed as Auto right now
 *  (the `patience_auto_only` SystemSetting; an explicit client preset is recorded as the
 *  requested depth but does not pick the run). Kept for REST / API callers — the web app
 *  stopped reading it when the Advanced tab was removed (c99b404a, 2026-10-27). No admin facts ride here. */
export interface DepthPolicy {
  autoOnly: boolean;
}

export const depthPolicyApi = {
  get: async (): Promise<DepthPolicy> => {
    const response = await apiClient.get('/crossmodel/depth/policy');
    return response.data.data;
  },
};

/** The always-Auto switch with its audit facts — GET /admin/settings/patience-auto-only (admin only). */
export interface PatienceAutoOnlyState {
  key: 'patience_auto_only' | string;
  enabled: boolean;
  /** ISO of the last flip write; null = never set (env boot default in force). */
  since: string | null;
  /** Admin identity that last flipped it; null = never set / the pre-audit 2026-09-26 20:35Z row. */
  updatedBy: string | null;
  source: 'setting' | 'env';
  bootDefault: boolean;
  envVar: string;
}

// ── Feeds (RETIRED, ticket 43c24152, 2026-10-20) ───────────────────────────
//
// Topic feeds were retired from the product: the create_feed / list_feeds /
// set_feed / refresh_feed / delete_feed tools are gone from the platform tool
// surface, the Feeds tab is gone from Settings, and the backend answers 410
// on every /feeds route. A topic digest is a schedule on a real chat now
// (schedule_message — full agent turn, memory, tools, delta-gating). Existing
// feeds were migrated to schedules on their own chats by the
// 20261020190000_retire_topic_feeds migration. The feedsApi client and the
// UserFeed / UserFeedEntry types were deleted with the Feeds tab.

// ── Admin API ─────────────────────────────────────────────────────────────

export interface DeepResearchUsageEntry {
  userId: string;
  email: string;
  name: string | null;
  count: number;
}

export interface DeepResearchUsageData {
  limit: number;
  usage: DeepResearchUsageEntry[];
  date: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
  lastActive: string | null;
  chatCount: number;
  messageCount: number;
  ticketCount: number;
}

export interface AdminStats {
  totalUsers: number;
  totalChats: number;
  newUsersToday: number;
  newUsers7d: number;
  newUsers30d: number;
  openTickets: number;
}

export interface JobHealthData {
  errorSummary: {
    last24h: { error: number; warn: number };
    last7d: { error: number; warn: number };
    last1h: { error: number };
    avgErrorsPerHour: number;
    errorSpike: boolean;
  };
  recentErrors: Array<{ id: string; level: string; message: string; source: string | null; createdAt: string }>;
  ticketPipeline: { open: number; inProgress: number; done7d: number; total: number };
  deployHealth: { status: string; checkedAt: string; frontendCode?: number; backendCode?: number };
}

export interface ApiCostModelRow {
  model: string;
  inTokens: number;
  outTokens: number;
  /** audit 2026-10-08 W3-2: prompt tokens served from the provider's cache (subset of inTokens; every provider shape). */
  cachedTokens?: number;
  /** cachedTokens / inTokens × 100 (one decimal); null when no input tokens. Absent on an older backend. */
  cacheHitPct?: number | null;
  runs: number;
  estimated: boolean;
  /** true for custom Edge endpoints ('<label>:<modelId>') — tokens real, dollars at generic list price */
  custom: boolean;
  listCostUsd: number;
  /** 2026-09-28: 'decision' = the decision gate's own calls (Jev / Laya / the DeepSeek readout), pivoted
   *  apart from the chat / coding rows of the same vendor and priced by the decision price table. */
  profile?: 'decision';
  /** decision rows: where the $ came from — 'list' | 'env' | 'registry' | 'self_hosted' | 'unpriced'. */
  priceSource?: string;
  /** decision rows: true when the $ is 0 because nothing prices it (self-hosted / unpriced) — the panel says so. */
  unpriced?: boolean;
  priceNote?: string;
}

/** The API-costs "Decision gate" block (GET /admin/api-costs → decisionGate; 2026-09-28). */
export interface DecisionGateCostBlock {
  windowDays: number;
  since: string;
  totals: { calls: number; pricedCalls: number; memoHits: number; inputTokens: number; usd: number };
  byBackend: Array<{ backend: string; model: string | null; calls: number; pricedCalls: number; inputTokens: number; usd: number; p50Ms: number | null; priceSource: string | null; unpriced: boolean }>;
  byPurpose: Array<{ purpose: string; calls: number; pricedCalls: number; inputTokens: number; usd: number; p50Ms: number | null }>;
  replaced: Array<{ purpose: string; unit: string; avoided: number; meanRunUsd: number | null; runsSampled: number; estimateUsd: number | null; basis: string }>;
  pricing: {
    typesafe: { usdPerMTokIn: number; usdPerMTokOut: number; source: string; note: string; url: string };
    envIn: string;
    envOut: string;
  };
}

export interface ApiCostUserRow {
  userId: string | null;
  email: string;
  totalUsd: number;
  codingUsd: number;
  chatUsd: number;
}

export interface ApiCostData {
  days: number;
  /** spend window actually used — loop_metrics retention clamps it at 30d */
  spendWindowDays: number;
  spendRecordedSince: string;
  /** recorded spend (Σ run_spend) — the authoritative total */
  totalSpendUsd: number;
  surfaceSpend: { coding: number; chat: number; chatResearch: number; decision?: number };
  triggerSpend: { user: number; machine: number; schedule: number; hook: number; decision?: number };
  models: ApiCostModelRow[];
  perUser: ApiCostUserRow[];
  /** 2026-09-28: the decision gate's own spend (null when the backend could not read it; absent on an older backend). */
  decisionGate?: DecisionGateCostBlock | null;
  /** Seats govern sessions (2026-09-28): what GOVERNED each coding run's model in the spend window
   *  (run_spend meta.modelSource — explicit | project | preference | seat | stamp; 'unstamped' =
   *  rows older than the change). Absent on a pre-change backend. */
  modelGovernance?: Array<{ source: string; runs: number; usd: number }>;
  /** audit 2026-10-08 W3-2: prompt-cache hit rate per profile (run_spend rows that carry inTokens). Absent on an older backend. */
  promptCacheByProfile?: Array<{ profile: string; runs: number; inTokens: number; cachedTokens: number; cacheHitPct: number }>;
  totalMessages: number;
  modeCounts: Record<string, number>;
  dailyTrend: Array<{ date: string; total: number }>;
}

/** Web-search provider status (ticket 6f4d42f2): what Admin → Settings → Web
 *  search shows. NEVER carries the key itself — only a masked preview. */
export interface WebSearchConfigStatus {
  provider: string;
  /** True when the store row exists (a key was saved), whether or not it is usable. */
  storeConfigured: boolean;
  /** False when the admin disabled the stored key (env creds are unaffected). */
  storeEnabled: boolean;
  /** True when the stored key no longer decrypts (JWT_SECRET rotated) — re-enter it. */
  storeReadable: boolean;
  /** Masked preview of the STORED key only ('••••1234'); null when none. */
  storePreview: string | null;
  zone: string | null;
  enabled: boolean;
  /** What the search backend resolves RIGHT NOW: 'env' | 'store' | null (not configured). */
  source: 'env' | 'store' | null;
  /** True when BRIGHTDATA_API_TOKEN is set in this process (store key ignored — precedence). */
  envPrecedence: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  /** The zone the backend ACTUALLY uses now (row → env → default) — the value
   *  to SHOW; `zone` is only the stored value (ticket 02f8c83f). */
  resolvedZone: string | null;
  /** true = the resolved zone exists on the account · false = it does NOT (every
   *  search answers HTTP 200 + empty body) · null = could not be checked. */
  zoneVerified: boolean | null;
  /** Why the zone could not be checked (only when zoneVerified is null). */
  zoneProbeError: string | null;
  /** Zones that exist on the account (empty when the probe could not answer). */
  activeZones: string[];
  /** A zone rejection the search tier observed: 200 + empty body + client_10002. */
  zoneError: { zone: string; code: string; at: string } | null;
}

// ── Instance setup (2026-10-20, self-host setup hardening) ────────────────────
// GET /api/crossmodel/instance/setup — what THIS instance has configured. Any
// signed-in user gets the booleans (the Integrations / Feeds tabs render "not
// set up on this instance"); admins also get the missing env NAMES, the how-to
// hints and the OAuth callback URLs (the Admin → Setup checklist). Never values.

export type InstanceSetupState = 'ready' | 'partial' | 'missing' | 'off';
export type InstanceSetupGroup = 'instance' | 'models' | 'web' | 'integrations' | 'messaging' | 'media' | 'coding';

export interface InstanceSetupFeature {
  key: string;
  label: string;
  group: InstanceSetupGroup;
  state: InstanceSetupState;
  /** The user-facing action works (Connect / search / send …). */
  configured: boolean;
  required: boolean;
  summary: string;
  /** In-app help anchor (/help/self-host#…). */
  help: string;
  /** Integrations only: the OAuth app is registered (false = Connect works by another path, e.g. a pasted token). */
  oauth?: boolean;
  // admin-only ↓
  missing?: string[];
  present?: string[];
  hint?: string;
  profile?: string;
  redirectUri?: string;
  note?: string;
}

export interface InstanceSetup {
  instance: { kind: string; selfHosted: boolean; publicUrl: string | null; cookieSecure: boolean; nodeEnv: string };
  summary: { ready: number; total: number; missingRequired: string[] };
  features: InstanceSetupFeature[];
  viewer: { admin: boolean };
}

export const instanceSetupApi = {
  /** What this instance has configured (booleans for everyone; names + hints for admins). */
  get: async (): Promise<InstanceSetup> => {
    const response = await apiClient.get('/crossmodel/instance/setup');
    return response.data.data;
  },
};

export const adminApi = {
  /** Get all system settings (admin only) */
  getSettings: async (): Promise<Record<string, string>> => {
    const response = await apiClient.get('/crossmodel/admin/settings');
    return response.data.data;
  },

  /** Admin → Settings → Web search status: what the search backend resolves
   *  right now ('env' | 'store' | null), the stored key's masked preview (the
   *  key itself is NEVER returned), zone, enabled, env-precedence. */
  getWebSearchConfig: async (): Promise<WebSearchConfigStatus> => {
    const response = await apiClient.get('/crossmodel/admin/web-search-config');
    return response.data.data;
  },


  /** Save (or clear) the Bright Data key/zone for self-hosted/Edge search.
   *  Body: { apiKey?, zone?, enabled?, clear? } — apiKey required the first
   *  time. The response is the status; the key is never echoed back. */
  saveWebSearchConfig: async (input: { apiKey?: string; zone?: string; enabled?: boolean; clear?: boolean }): Promise<WebSearchConfigStatus> => {
    const response = await apiClient.put('/crossmodel/admin/web-search-config', input);
    return response.data.data;
  },

  /** Update a single system setting (admin only) */
  updateSetting: async (key: string, value: string): Promise<void> => {
    await apiClient.put(`/crossmodel/admin/settings/${encodeURIComponent(key)}`, { value });
  },

  /** The two supervisor OFF switches with since / updatedBy / skipped (admin only; owner 2026-09-26). */
  getSupervisorSwitches: async (): Promise<SupervisorSwitchState> => {
    const response = await apiClient.get('/crossmodel/admin/settings/supervisors');
    return response.data.data;
  },

  /**
   * Flip one supervisor switch (admin only): PUT /admin/settings/<key> with
   * body { value: '1' | '0' }. Idempotent — `changed:false` when the stored
   * value already matched; the response carries the fresh state.
   */
  setSupervisorSwitch: async (key: SupervisorSwitchTargetState['key'], enabled: boolean): Promise<{ changed: boolean; state: SupervisorSwitchState }> => {
    const response = await apiClient.put(`/crossmodel/admin/settings/${encodeURIComponent(key)}`, { value: enabled ? '1' : '0' });
    return { changed: Boolean(response.data?.changed), state: response.data?.state };
  },

  /** The always-Auto switch (`patience_auto_only`) with since / updatedBy (admin only; audit 2026-09-26). */
  getPatienceAutoOnly: async (): Promise<PatienceAutoOnlyState> => {
    const response = await apiClient.get('/crossmodel/admin/settings/patience-auto-only');
    return response.data.data;
  },

  /**
   * Flip the always-Auto switch (admin only): PUT /admin/settings/patience_auto_only
   * with body { value: '1' | '0' }. Idempotent — `changed:false` when the stored
   * value already matched; the response carries the fresh audited state.
   */
  setPatienceAutoOnly: async (enabled: boolean): Promise<{ changed: boolean; state: PatienceAutoOnlyState }> => {
    const response = await apiClient.put('/crossmodel/admin/settings/patience_auto_only', { value: enabled ? '1' : '0' });
    return { changed: Boolean(response.data?.changed), state: response.data?.state };
  },

  /** Get today's deep_research usage across all users (admin only) */
  getDeepResearchUsage: async (): Promise<DeepResearchUsageData> => {
    const response = await apiClient.get('/crossmodel/admin/deep-research-usage');
    return response.data.data;
  },

  /** Get admin stats (admin only) */
  getStats: async (): Promise<AdminStats> => {
    const response = await apiClient.get('/crossmodel/admin/stats');
    return response.data.data;
  },

  /** Get all users with activity data (admin only) */
  getUsers: async (): Promise<AdminUser[]> => {
    const response = await apiClient.get('/crossmodel/admin/users');
    return response.data.data;
  },

  /** Get API cost metrics (admin only) */
  getApiCosts: async (days?: number): Promise<ApiCostData> => {
    const response = await apiClient.get('/crossmodel/admin/api-costs', { params: { days } });
    return response.data.data;
  },

  /** Delete a user and all their data (admin only) */
  deleteUser: async (userId: string): Promise<{ message: string }> => {
    const response = await apiClient.delete(`/crossmodel/admin/users/${userId}`);
    return response.data;
  },

  /** Promote a user to admin or back to user (admin only). */
  setUserRole: async (userId: string, role: 'ADMIN' | 'USER'): Promise<{ id: string; email: string; role: string }> => {
    const response = await apiClient.patch(`/crossmodel/admin/users/${userId}/role`, { role });
    return response.data.data;
  },

  /** Get job health dashboard data (admin only) */
  getJobHealth: async (): Promise<JobHealthData> => {
    const response = await apiClient.get('/crossmodel/admin/job-health');
    return response.data.data;
  },
};

// ── News Headlines API ────────────────────────────────────────────────────────

export interface NewsHeadline {
  headline: string;
  summary: string;
  category: 'local' | 'us' | 'interest';
  chatPrompt: string;
  /** Ticket 94b93132: the story's publication date or age label, copied verbatim
   * from the search result it came from (e.g. "3 hours ago", "Oct 28, 2021").
   * '' (or missing, on briefings cached before the field existed) = no date was
   * shown for the story — the UI then displays the item WITHOUT a date instead
   * of implying it is from today. */
  published?: string;
}

export interface NewsResponse {
  headlines: NewsHeadline[];
  pending: boolean;
  /** True when the backend knows it recently failed to produce news (per-user
   * failure backoff or the fetch circuit breaker) — the card shows the honest
   * unavailable state instead of "checking every few seconds". */
  degraded: boolean;
  /** Self-host setup hardening (2026-10-20): this instance has no web search, so no
   *  briefing can ever be built — the card says so instead of polling forever. */
  unconfigured: boolean;
  /** 2026-10-26: which pipeline piece is missing — 'search' (no web-search
   *  backend) or 'formatter' (no utility LLM: a gateway-only self-host with no
   *  DEEPSEEK_API_KEY / DASHSCOPE_API_KEY and no Utility seat assignment).
   *  Drives the honest copy; absent on configured instances. */
  unconfiguredReason?: 'search' | 'formatter';
}

export const newsApi = {
  /** Get personalized news headlines for the home screen */
  getHeadlines: async (): Promise<NewsResponse> => {
    const response = await apiClient.get('/crossmodel/news');
    return {
      headlines: response.data.data || [],
      pending: !!response.data.pending,
      degraded: !!response.data.degraded,
      unconfigured: !!response.data.unconfigured,
      unconfiguredReason: response.data.unconfiguredReason,
    };
  },
};

// ── Calendar Events API (Home Screen) ─────────────────────────────────────────

export interface CalendarEvent {
  title: string;
  startTime: string;
  endTime: string;
  startRaw: string;   // full date string from MCP — used to determine past/future
  endRaw: string;     // full date string from MCP — used to determine past/future
  startEpoch: number; // milliseconds since epoch — reliable past/future comparison
  endEpoch: number;   // milliseconds since epoch — reliable past/future comparison
  location?: string;
  description?: string;
  account?: string;
  aiPrompts: string[];  // 2-3 unique contextual follow-up suggestions
  /** @deprecated kept for backward compat — use aiPrompts instead */
  aiPrompt?: string;
  /** Which calendar the row came from (2026-11-06 unification). ABSENT on
   *  responses from an older backend ⇒ treat as 'google' (the only source
   *  that existed). Apple rows also carry their EventKit id + calendar name
   *  in `account`. */
  source?: 'google' | 'apple';
  eventId?: string;
  allDay?: boolean;
}

export interface CalendarEventsResponse {
  connected: boolean;
  events: CalendarEvent[];
  /** Set when the calendar IS connected but today's read failed (2026-10-21) —
   *  the home card says so instead of vanishing. 'reconnect' = the Google
   *  token can no longer be refreshed (e.g. the OAuth client was rotated):
   *  the user must reconnect Google in Account → Integrations. */
  error?: 'unavailable' | 'reconnect';
  /** The APPLE half of the card (2026-11-06). Absent when no Mac is paired or
   *  an older backend answered. `state !== 'ok'` means the Apple calendar
   *  could NOT be read — the card says so and NEVER renders it as an empty
   *  day (the bug that made a never-granted Mac look like a free schedule). */
  apple?: CalendarAppleHalf;
}

/** The macOS Calendar half's own verdict, mirroring the backend's classified
 *  states. `granted`/`denied`… arrive inside `consent` and describe the LAST
 *  consent attempt — never an inference about a dialog the agent did or did
 *  not show. */
export interface CalendarAppleHalf {
  state:
    | 'ok'
    | 'no-calendar-account'
    | 'calendar-denied'
    | 'calendar-never-requested'
    | 'calendar-unreachable'
    | 'unsupported'
    | 'no-agent';
  /** The Mac that answered (or would have answered). */
  device: string | null;
  via?: 'targeted' | 'default' | 'fallback' | 'none';
  error?: string;
  consent?: {
    state: 'dialog-open' | 'dispatched' | 'granted' | 'denied' | 'bridge-failed' | 'request-failed';
    at: string;
    observedTier: number | null;
    idiom: string;
    requestExit: 'ok' | 'timeout' | 'error' | 'staging-failed';
    version: string;
  };
  /** Macs skipped because they last reported no Apple account. */
  skippedSignedOut?: string[];
}

export const calendarApi = {
  /** Get today's calendar events for the home screen */
  getTodayEvents: async (): Promise<CalendarEventsResponse> => {
    const response = await apiClient.get('/crossmodel/calendar-events');
    return response.data.data || { connected: false, events: [] };
  },
};

// ── Memory API ────────────────────────────────────────────────────────────────

export const memoryApi = {
  getMemory: async (): Promise<Record<string, string>> => {
    const response = await apiClient.get('/crossmodel/memory');
    return response.data.data.facts || {};
  },

  updateFact: async (key: string, value: string): Promise<void> => {
    await apiClient.put('/crossmodel/memory', { key, value });
  },

  deleteFact: async (key: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/memory?key=${encodeURIComponent(key)}`);
  },

  clearMemory: async (): Promise<void> => {
    await apiClient.delete('/crossmodel/memory');
  },

  /** 2026-09-15: rebuild MY memory from my own past conversations (background job). */
  rebuildMemory: async (): Promise<{ started: boolean; reason?: string; total: number; message?: string }> => {
    const response = await apiClient.post('/crossmodel/memory/rebuild');
    return { ...(response.data.data || {}), message: response.data.message };
  },
  rebuildStatus: async (): Promise<MemoryRebuildStatusResponse> => {
    const response = await apiClient.get('/crossmodel/memory/rebuild');
    return response.data.data;
  },
};

export interface MemoryRebuildStatusResponse {
  status: {
    startedAt: string;
    finishedAt: string | null;
    total: number;
    processed: number;
    factsBefore: number;
    factsAfter: number | null;
    error?: string;
  } | null;
  running: boolean;
  facts: number;
}

// ── Suggested Starter Questions API (Home Screen) ─────────────────────────────

export interface SuggestedQuestionsResponse {
  questions: string[];
  pending: boolean;
  /** Terminal: this instance has no utility LLM configured (gateway-only
   *  self-host) — the defaults are what it serves; the client stops polling
   *  instead of re-fetching a never-generating pipeline. */
  unconfigured?: boolean;
}

export const suggestionsApi = {
  /** Get personalized conversation-starter questions for the home screen */
  getStarterQuestions: async (): Promise<SuggestedQuestionsResponse> => {
    const response = await apiClient.get('/crossmodel/suggested-questions');
    return {
      questions: response.data.data || [],
      pending: !!response.data.pending,
      unconfigured: !!response.data.unconfigured,
    };
  },
};

// ── Weather API (Home Screen) ─────────────────────────────────────────────────

export interface HomeWeather {
  available: boolean;
  location?: {
    name: string;
    region?: string;
    country?: string;
  };
  current?: {
    tempC: number;
    tempF: number;
    apparentC: number;
    code: number;
    description: string;
    icon: string;
    windKph: number;
    humidity: number;
    isDay: boolean;
  };
  today?: {
    maxC: number;
    minC: number;
    maxF: number;
    minF: number;
  };
  updatedAt?: string;
}

export const weatherApi = {
  /** Get the user's location + current weather for the home screen header */
  getWeather: async (opts?: { signal?: AbortSignal }): Promise<HomeWeather> => {
    const response = await apiClient.get('/crossmodel/weather', { signal: opts?.signal });
    return response.data.data || { available: false };
  },
};
