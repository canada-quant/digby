/**
 * @deprecated P5-B: sessions ARE chats. The canonical API surface is
 * `/api/crossmodel/chats/*` (see lib/api/crossmodel.ts) and
 * `/api/crossmodel/platform/*` for agents (docs/DIGBY_PLATFORM_API.md).
 * This module remains only as a compatibility shim for the coding run/steer/
 * stream helpers CodeSessionView still consumes — do not add new call sites.
 */
import apiClient from '../api-client';
import type { CheckState, DepthChip, DepthMeta } from '../depth-ux';
import type { TaskEventPayload } from '../task-card';

/** Finite ceiling for the steer POST — apiClient itself carries no default
 * timeout, and a hung steer wedged the composer's `steering` state forever
 * (ticket 55e9967d). Exported so the regression test pins the same value. */
export const STEER_TIMEOUT_MS = 30_000;

// ── Types ──────────────────────────────────────────────────────────────────────
// Legacy ids stay in the union because the /coding/* API returns the STORED
// session model unnormalized (normalization happens at run time, not on read):
// 'kimi-k2.6'       — sessions persisted before the K3 switch (2026-07-17);
// 'glm-5.2'         — sessions persisted before the GLM-5.3 cutover (2026-09-03);
// 'deepseek-v4-pro' — sessions persisted before the DeepSeek V4.1 Flash cutover (2026-09-10).
export type CodingModel = 'glm-5.3' | 'deepseek-flash' | 'kimi-k3' | 'glm-5.2' | 'kimi-k2.6' | 'deepseek-v4-pro';
export type PermissionMode = 'auto' | 'plan' | 'ask';

export interface CodingProject {
  id: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  provider: string;
  githubLabel: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { sessions: number };
}

export interface CodingSession {
  id: string;
  projectId: string;
  /** Owner of the session (the chat row's userId) — the session view uses it to
   *  render a read-only composer for project members (ticket 7acaa7ba). */
  userId?: string;
  title: string;
  branch: string;
  baseBranch: string;
  worktreePath: string | null;
  permissionMode: PermissionMode;
  model: CodingModel;
  status: 'provisioning' | 'ready' | 'running' | 'error' | 'archived';
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A Settings-started dev-container action (2026-10-13): progress lives on the server. */
export interface DevContainerActionRecord {
  action: 'restart' | 'tailnet_restart' | 'tailnet_reconnect';
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  note?: string;
}

export interface DevContainerStatus {
  enabled: boolean;
  running: boolean;
  container: string;
  image: string;
  tailscale: {
    state: string; ip4?: string; hostname?: string; loginUrl?: string;
    /** 2026-10-13: the node as Tailscale sees it. keyExpiry null = never expires (tagged). */
    online?: boolean; keyExpiry?: string | null; tags?: string[]; loginPending?: boolean;
  } | null;
  keyConfigured: boolean;
  /** Per-session egress scoping posture (ticket 4ed6eb2e). unknown = the coding server didn't answer. */
  egress: {
    mode: 'scoped' | 'legacy' | 'degraded' | 'off' | 'unknown';
    shim: boolean | null;
    policyRules: number | null;
    note?: string;
  };
  /** Where the status came from (2026-10-13): unreachable = live state unknown. */
  reach?: 'local' | 'remote' | 'unreachable';
  action?: DevContainerActionRecord | null;
  note?: string;
}

/** Per-user tailnet egress policy (ticket 4ed6eb2e). allow: rule strings
 *  (host / .suffix / CIDR / *, optional :port); null = allow-all. */
export interface TailnetEgressPolicy {
  allow: string[] | null;
  pushed?: boolean;
}

export interface CodingCredentialSummary {
  id: string;
  provider: string;
  envKey: string;
  label: string;       // '' = primary; 'WORK' → injected as envKey_WORK
  injectedKey: string; // the env var name this credential is injected under
  preview: string; // '••••1234'
  readable: boolean; // false = no longer decrypts (secret rotated) — delete + re-save
  warning?: string | null; // all-caps value anomaly note (ticket 8a46847f) — values are stored verbatim, so ALL-CAPS = mangled at entry
  updatedAt: string;
}

export interface MessagePart {
  type: 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'subagent' | 'image' | 'task';
  /** Inline task card (cohesive chat, 2026-09-28 — lib/task-card.ts): the
   *  harness's task contract this part carries (type 'task'). ONE part per
   *  taskId on the assistant row of the turn that started the task, replaced
   *  in place on every update; rendered by <TaskCard/>. Never model prose. */
  task?: TaskEventPayload;
  /** ISO wall-clock time the part was created — backend stamps at push time;
   *  the live stream uses the frame's server `ts` (falling back to client
   *  ingest for pre-2026-09 servers). Drives per-block hover timestamps in
   *  AssistantParts. Absent on pre-2026-08 persisted rows. */
  ts?: string;
  /** Harness guard marker (2026-09-08): the loop's own notice that the
   *  preceding draft was discarded (zero-tool gate) or rejected back
   *  (evidence guard). Rendered as a callout; never coalesced with text. */
  marker?: 'guard';
  /** A text draft the evidence guard REJECTED before submission — kept for
   *  audit, rendered collapsed as "Rejected draft — not submitted". */
  struck?: boolean;
  // image parts (base64 `data` WITHOUT the `data:…;base64,` prefix) — OR a lazy
  // same-origin `url` when the server stripped the inline bytes (getSession
  // always strips; `data` then only survives on live-streamed/echo parts).
  mediaType?: string;
  data?: string;
  url?: string;
  name?: string;
  /** Screenshots in the chat (2026-09-23): an assistant image part attached by
   *  browser_task ('browser') / computer_task ('computer') — the final frame,
   *  rendered under the tool card with `name` as its caption. 'generated'
   *  (2026-09-24): a picture generate_image made — persisted with a lazy
   *  `url` (/api/crossmodel/generated-files/<fileId>/inline, never base64)
   *  and rendered as a framed figure with Download / Open actions. */
  source?: 'browser' | 'computer' | 'generated';
  /** Page URL at capture (browser). NOT `url` — that is the lazy image URL. */
  pageUrl?: string;
  /** Frontmost app at capture (computer). */
  app?: string;
  /** GeneratedFile id of a generated image (source 'generated') — the Files
   *  page row; Download/Open actions and the lazy `url` derive from it. */
  fileId?: string;
  /** The prompt the image was generated from (source 'generated'). */
  prompt?: string;
  [k: string]: any;
}

/** An image attached to a run/steer request (base64 `data`, no `data:` prefix). */
export interface ChatImage { mediaType: string; data: string; name?: string }

/** Vision-capable coding models — mirrors backend coding-model.ts `supportsVision`
 *  (kimi-k3, kimi-k2.6, qwen3.6-27b, deepseek-flash = DeepSeek V4.1 Flash, 2026-09-10).
 *  The retired 'deepseek-v4-pro' stays because the /coding/* API returns a
 *  pre-cutover session's STORED id, and that session runs on deepseek-flash
 *  (vision) at run time. Text-only models (glm-5.3) get describe-and-inject
 *  server-side. */
const VISION_MODELS = new Set(['kimi-k3', 'kimi-k2.6', 'qwen3.6-27b', 'deepseek-flash', 'deepseek-v4-pro']);
export const modelSupportsVision = (model: string | undefined | null): boolean => !!model && VISION_MODELS.has(model);

/** Plain-chat message metadata carried into the unified view (One-Session P2
 *  increment 2): populated ONLY by plain-session.mapPlainMessages from
 *  CrossModelMessage.metadata — the coding backend never sets it. Drives the
 *  ported legacy transcript extras (Sources pills, Suggested-next chips,
 *  admin More-info panel, user-bubble attachment chips). */
export interface PlainMessageMeta {
  followUps?: string[];
  sources?: Array<{ documentName: string; mimeType?: string; content?: string; relevanceScore?: number; metadata?: { page?: number } }>;
  models?: Record<string, any>;
  modelSet?: string;
  modelLabels?: Record<string, string>;
  mode?: string;
  synthesisTime?: number;
  totalTime?: number;
  /** Echo-only (never persisted): the attachments sent with this user message,
   *  so the bubble renders thumbnails/chips like the legacy view. Persisted
   *  rows (backend metadata.attachments) additionally carry uploadId — and
   *  fileId + mimeType once getChatById has joined the durable ChatFile row
   *  (ticket c6e8edda) — so image chips render inline after a reload. */
  attachments?: Array<{ filename: string; type: string; uploadId?: string; fileId?: string; mimeType?: string; localPreview?: string }>;
  /** Machine-traffic classification (feedback 4959bb1c): the backend origin
   *  stamp ('schedule'|'hook'|'webhook'|'agent'|'machine'|…) — carried through
   *  by mapPlainMessages so machine/inter-agent/system rows collapse here too. */
  origin?: string;
  /** metadata.kind — 'owner_briefing' marks the plain-English briefing layer
   *  (owner 2026-09-04): exempt from machine-turn grouping, renders as a
   *  regular assistant bubble. */
  kind?: string;
  /** origin 'agent' relays: the sending chat's id. */
  sourceChatId?: string;
  /** Ticket 6ef770a1: the wake user row was fired by an OWNER-ARMED schedule
   *  (CodingSchedule.promptSetBy 'user' — schedule_message from a real user
   *  turn). The machine-turn grouping reads it off the group's ANCHOR row to
   *  render the whole turn EXPANDED with a "requested" marker: owner-armed
   *  digests are delivered content, not internal wake noise. Legacy rows
   *  (absent) render collapsed exactly as before. */
  scheduleOwnerArmed?: boolean;
  /** Ticket 56d6b204: the wake user row was fired by the auto-wired
   *  child→parent RESULT hook (isChildResultTemplate / createdVia
   *  'system:child-result-hook'). The machine-turn grouping reads it off the
   *  group's ANCHOR row to render the whole turn EXPANDED with a "results"
   *  marker: a sub-session's completed verdict is delivered content the
   *  owner is waiting on, not internal wake noise (the 2026-09-25 incident,
   *  chat 6e36c834 — the DB-audit result stayed hidden behind the collapsed
   *  accordion). Legacy rows (absent) are caught by the content-signature
   *  fallback in machine-turn-grouping. */
  childResult?: boolean;
  /** Fixer 2026-09-27 (tt-rd audit, finding upward-chatter-1): true on the
   *  wake user row of an [OWNER ASK UNANSWERED] re-wake / [FOLLOW-THROUGH]
   *  nudge and on its answering assistant row. The machine-turn grouping reads
   *  it off the group's ANCHOR row to render the turn EXPANDED with an
   *  "answer" marker — the reply the owner asked for, never folded away. */
  ownerAskReply?: boolean;
  /** Coding-run provenance (2026-09-15): 'user' | 'schedule' | 'hook' | 'machine'
   *  stamped by the run executor on the final row, so a machine-triggered note
   *  folds into a one-line accordion even when its wake row is paged out. */
  triggerKind?: string;
  /** The schedule that fired the run (machine finals only). */
  scheduleId?: string;
  /** Owner 2026-09-18 ("users get the first available answer"): the Double
   *  Checker was still working when this answer shipped — the backend clears
   *  it (and may revise the row) when the draft lands; the view polls while true. */
  pendingCrossCheck?: boolean;
  /** Ticket 318b3175 (echo-only, NEVER persisted): the complete event's
   *  finalText REPLACED the streamed text at run finalize (cross-check
   *  reconcile, action-guard strike, unbacked-claim rewrite, seat fallback…).
   *  The live bubble renders a "corrected before delivery" note so the swap
   *  reads as a correction, not a silent "shrink" (the owner watched a long
   *  streaming answer collapse with no explanation). */
  corrected?: boolean;
  /** Set when the late cross-check REVISED this answer in place. */
  revision?: { at: string; reason: string; checkerTimeMs?: number; previousContent?: string };
  /** The late cross-check's outcome for this row (revised | unchanged | no_draft | conversation_moved | reconcile_failed | timeout). */
  crossCheck?: { outcome: string; checkerTimeMs?: number; reconcileMs?: number; at?: string };
  /** Depth UX (compute policy, 2026-09-26 — lib/depth-ux.ts): the harness's
   *  check state for this answer (persisted metadata.check; the live stream's
   *  last `check_state` event folds in at complete). Drives the ONE pill under
   *  the bubble; legacy rows fall back to pendingCrossCheck / revision / crossCheck. */
  check?: CheckState;
  /** metadata.depth — the plan the harness ran for this answer (preset,
   *  checker, council, source, decisionId). The Dig-deeper chip derives the
   *  next rung from it on reload when the server sent no chips. */
  depth?: DepthMeta;
  /** The server-appended chips from the followups/complete payload: at most
   *  ONE `escalate` ("Dig deeper") or a `signin_deeper` for guests. */
  chips?: DepthChip[];
  /** USER echo rows only: this send was a Dig-deeper escalation of that
   *  assistant message (counts the rungs spent on it). */
  escalationOf?: string;
  /** Harness status cards (project_status / session_status): the SHARED CONTRACT
   *  object and its generation stamp ride the row's metadata verbatim. */
  status?: unknown;
  generatedAt?: string;
  /** Inline task card (cohesive chat, 2026-09-28): the hand-off branch may
   *  also stamp the task contract on the final row's metadata — the
   *  sub-session Result section reads it when no `task` part is present
   *  (lib/task-card.ts findSessionResult). Parsed, never trusted raw. */
  task?: unknown;
  /** Shared-project author attribution (58ffcf86; C2 port, ticket 71b1fec6) —
   *  USER rows only: the account that sent this message (backend
   *  metadata.authorId). Legacy rows have none and render exactly as before. */
  authorId?: string;
  /** Display name resolved at map time from the chat payload's additive
   *  messageAuthors map (may be absent — e.g. a deleted account — in which
   *  case the footnote falls back to 'teammate'). */
  authorName?: string;
}

export interface CodingMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  parts?: MessagePart[];
  createdAt: string;
  plainMeta?: PlainMessageMeta;
  /** Server row metadata as stored (coding transcript reads carry it since
   *  2026-09-15). CodeSessionView bridges it into plainMeta at apply time so
   *  every classifier (machine fold, harness cards) reads ONE field. */
  metadata?: PlainMessageMeta;
}

export interface GithubRepo {
  fullName: string;
  name: string;
  cloneUrl: string;
  defaultBranch: string;
  private: boolean;
  updatedAt: string;
  githubLabel: string;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface PlanStep {
  id: number;
  text: string;
  status: TodoStatus;
  note?: string;
}

export interface CodingPlan {
  goal: string;
  acceptanceCriteria: string[];
  steps: PlanStep[];
  version: number;
  updatedAt: string;
}

// ── REST ──────────────────────────────────────────────────────────────────────
export const codingApi = {
  listGithubRepos: async (): Promise<{ connected: boolean; repos: GithubRepo[] }> => {
    const r = await apiClient.get('/crossmodel/coding/github-repos');
    return r.data.data;
  },
  listProjects: async (): Promise<CodingProject[]> => {
    const r = await apiClient.get('/crossmodel/coding/projects');
    return r.data.data;
  },
  importProject: async (body: {
    repoUrl?: string; name?: string; defaultBranch?: string; githubLabel?: string; provider?: string;
  }): Promise<CodingProject> => {
    const r = await apiClient.post('/crossmodel/coding/projects', body);
    return r.data.data;
  },
  deleteProject: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/coding/projects/${id}`);
  },
  listSessions: async (projectId: string): Promise<CodingSession[]> => {
    const r = await apiClient.get(`/crossmodel/coding/projects/${projectId}/sessions`);
    return r.data.data;
  },
  createSession: async (projectId: string, body: { title?: string; permissionMode?: PermissionMode }): Promise<CodingSession> => {
    const r = await apiClient.post(`/crossmodel/coding/projects/${projectId}/sessions`, body);
    return r.data.data;
  },
  /** One-Digby C5: commit a canvas into the project repo's knowledge branch. */
  commitKnowledge: async (projectId: string, body: { name: string; content: string }): Promise<{ success: boolean; message: string }> => {
    const r = await apiClient.post(`/crossmodel/coding/projects/${projectId}/knowledge`, body);
    return r.data?.data || r.data;
  },

  // ── CLI/API credentials (Cloudflare, AWS, Namecheap, Brev, custom) ──
  // Write-only: list returns masked previews, never the stored value.
  listCredentials: async (): Promise<CodingCredentialSummary[]> => {
    const r = await apiClient.get('/crossmodel/coding/credentials');
    return r.data.data;
  },
  saveCredential: async (provider: string, envKey: string, value: string, label?: string): Promise<CodingCredentialSummary> => {
    const r = await apiClient.put('/crossmodel/coding/credentials', { provider, envKey, value, ...(label ? { label } : {}) });
    return r.data.data;
  },
  deleteCredential: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/coding/credentials/${id}`);
  },

  // ── Shared tailnet dev container (Account → Coding; ticket 3ba5d35d) ──
  devContainerStatus: async (): Promise<DevContainerStatus> => {
    const response = await apiClient.get('/crossmodel/coding/dev-container/status');
    return response.data.data;
  },
  devContainerRestart: async (): Promise<DevContainerStatus> => {
    const response = await apiClient.post('/crossmodel/coding/dev-container/restart');
    return response.data.data;
  },
  /** Rejoin the running container to the tailnet with the SAVED key (mid-run safe; 2026-10-13). */
  devContainerReconnect: async (): Promise<DevContainerStatus> => {
    const response = await apiClient.post('/crossmodel/coding/dev-container/tailnet/reconnect');
    return response.data.data;
  },

  // ── Per-session tailnet egress scoping (ticket 4ed6eb2e) ──
  tailnetEgressPolicy: async (): Promise<TailnetEgressPolicy> => {
    const response = await apiClient.get('/crossmodel/coding/dev-container/egress');
    return response.data.data;
  },
  saveTailnetEgressPolicy: async (allow: string[] | null): Promise<TailnetEgressPolicy> => {
    const response = await apiClient.put('/crossmodel/coding/dev-container/egress', { allow });
    return response.data.data;
  },

  /**
   * Session state + transcript. Paged when `paging.messageLimit` is set: the
   * response is the NEWEST page (chronological within it) + hasMoreMessages /
   * nextMessagesBefore — pass that cursor back as `messagesBefore` for the next
   * OLDER page (prepend client-side). Omit for the legacy full transcript.
   */
  getSession: async (id: string, paging?: { messageLimit?: number; messagesBefore?: string; signal?: AbortSignal }): Promise<CodingSession & {
    messages: CodingMessage[]; project: CodingProject;
    hasMoreMessages?: boolean; nextMessagesBefore?: string;
    sessionUsage?: any; uiState?: any; scheduleHealth?: any;
  }> => {
    const params = new URLSearchParams();
    if (paging?.messageLimit !== undefined) params.set('messageLimit', String(paging.messageLimit));
    if (paging?.messagesBefore) params.set('messagesBefore', paging.messagesBefore);
    const qs = params.toString();
    const r = await apiClient.get(`/crossmodel/coding/sessions/${id}${qs ? `?${qs}` : ''}`, { signal: paging?.signal });
    return r.data.data;
  },
  /** Ids of MY currently-running sessions — the sidebar polls this to stop
   *  spinners on runs that finished while their view was unmounted. */
  listRunning: async (opts?: { signal?: AbortSignal }): Promise<string[]> => {
    const r = await apiClient.get('/crossmodel/coding/sessions/running', { signal: opts?.signal });
    return r.data.data.runningIds;
  },
  updateSession: async (id: string, body: { title?: string; permissionMode?: PermissionMode; archived?: boolean }): Promise<CodingSession> => {
    const r = await apiClient.put(`/crossmodel/coding/sessions/${id}`, body);
    return r.data.data;
  },
  archiveSession: async (id: string, archived: boolean): Promise<CodingSession> => {
    const r = await apiClient.put(`/crossmodel/coding/sessions/${id}`, { archived });
    return r.data.data;
  },
  deleteSession: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/coding/sessions/${id}`);
  },
  getDiff: async (id: string): Promise<{ status: string; diffStat: string; branch: string }> => {
    const r = await apiClient.get(`/crossmodel/coding/sessions/${id}/diff`);
    return r.data.data;
  },
  approve: async (approvalId: string, decision: 'allow' | 'always' | 'deny'): Promise<void> => {
    await apiClient.post(`/crossmodel/coding/approvals/${approvalId}`, { decision });
  },
  /** Answer an ask_user question the orchestrator is blocked on. Returns the
   *  server's success envelope (992c8374): {success:false} means the wait was
   *  already gone — callers must surface that instead of clearing the card
   *  silently (the "answered 3×, card came back" incident). */
  answerQuestion: async (questionId: string, answer: string): Promise<{ success: boolean; error?: string }> => {
    const r = await apiClient.post(`/crossmodel/coding/questions/${questionId}`, { answer });
    return r.data;
  },
  /** Start a run — the prompt rides the POST body (no URL-length limit). Then attach via streamUrl(sid,''). */
  startRun: async (sessionId: string, message: string, images?: ChatImage[], uploadIds?: string[]): Promise<void> => {
    // uploadIds (7b5ee09b): staged /crossmodel/upload ids (PDF/DOCX/XLSX…)
    // resolve server-side into real files staged into the session worktree.
    await apiClient.post(`/crossmodel/coding/sessions/${sessionId}/run`, {
      message,
      ...(images?.length ? { images } : {}),
      ...(uploadIds?.length ? { uploadIds } : {}),
    });
  },
  stopRun: async (sessionId: string): Promise<{ stopping: boolean }> => {
    const r = await apiClient.post(`/crossmodel/coding/sessions/${sessionId}/stop`);
    return { stopping: !!r.data.data?.stopping };
  },
  /** Steer an ACTIVE run — inject a message the agent folds in at its next step. */
  steerRun: async (sessionId: string, message: string, images?: ChatImage[], uploadIds?: string[]): Promise<void> => {
    // FINITE timeout is load-bearing (ticket 55e9967d): apiClient has no
    // default timeout, so a hung POST never settled and the caller's
    // `steering` state stayed true forever — send button permanently
    // disabled. The steer is a Redis rPush; 30s is generous.
    await apiClient.post(`/crossmodel/coding/sessions/${sessionId}/steer`, {
      message,
      ...(images?.length ? { images } : {}),
      ...(uploadIds?.length ? { uploadIds } : {}), // 7b5ee09b: staged upload ids ride the steer too
    }, { timeout: STEER_TIMEOUT_MS });
  },
  push: async (sessionId: string): Promise<{ success: boolean; message: string }> => {
    const r = await apiClient.post(`/crossmodel/coding/sessions/${sessionId}/push`);
    return { success: r.data.success, message: r.data.data?.message || '' };
  },
  openPr: async (sessionId: string, title?: string, body?: string): Promise<{ success: boolean; message: string }> => {
    const r = await apiClient.post(`/crossmodel/coding/sessions/${sessionId}/pr`, { title, body });
    return { success: r.data.success, message: r.data.data?.message || '' };
  },
  // ── Plan / goal / todos (sidebar Overview) ──
  getPlan: async (sessionId: string): Promise<CodingPlan | null> => {
    const r = await apiClient.get(`/crossmodel/coding/sessions/${sessionId}/plan`);
    return r.data.data?.plan ?? null;
  },
  setGoal: async (sessionId: string, goal: string, acceptanceCriteria?: string[]): Promise<CodingPlan> => {
    const r = await apiClient.put(`/crossmodel/coding/sessions/${sessionId}/plan/goal`, { goal, acceptanceCriteria });
    return r.data.data.plan;
  },
  addTodo: async (sessionId: string, text: string): Promise<CodingPlan> => {
    const r = await apiClient.post(`/crossmodel/coding/sessions/${sessionId}/plan/todos`, { text });
    return r.data.data.plan;
  },
  setTodoStatus: async (sessionId: string, stepId: number, status: TodoStatus): Promise<CodingPlan> => {
    const r = await apiClient.patch(`/crossmodel/coding/sessions/${sessionId}/plan/todos/${stepId}`, { status });
    return r.data.data.plan;
  },
  deleteTodo: async (sessionId: string, stepId: number): Promise<CodingPlan> => {
    const r = await apiClient.delete(`/crossmodel/coding/sessions/${sessionId}/plan/todos/${stepId}`);
    return r.data.data.plan;
  },

  /**
   * SSE run URL (EventSource uses a query token — it can't set headers).
   * P4: THE one attach endpoint for BOTH pipelines — GET /api/crossmodel/chats/:id/stream.
   * (The retired /coding/sessions/:id/stream 308-redirects here; `message` remains
   * the back-compat run-start param the unified endpoint honors for coding chats.)
   * `afterSeq` (0c158104): the client's composite `<runId>:<seq>` resume cursor —
   * the server replays only events past it instead of the whole run log.
   */
  streamUrl: (sessionId: string, message: string, afterSeq?: string): string => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') || '' : '';
    const params = new URLSearchParams({ message, token });
    if (afterSeq) params.set('after_seq', afterSeq);
    return `/api/crossmodel/chats/${sessionId}/stream?${params.toString()}`;
  },
  /** Live-preview URL for a dev server running on `port` inside the session (iframe src). */
  previewUrl: (sessionId: string, port: number, nonce = 0): string => {
    const token = typeof window !== 'undefined' ? localStorage.getItem('accessToken') || '' : '';
    const params = new URLSearchParams({ token });
    if (nonce) params.set('_r', String(nonce)); // cache-bust on reload
    // Serve from the dedicated cross-origin preview host when configured (else same origin).
    const base = PREVIEW_HOST ? `https://${PREVIEW_HOST}` : '';
    return `${base}/api/crossmodel/coding/sessions/${sessionId}/preview/${port}/?${params.toString()}`;
  },
};

/**
 * Optional dedicated preview origin (e.g. "preview.digby.ai"). When set, the app
 * frames previews cross-origin, so a previewed dev server's JS can't reach the
 * app's localStorage — which is why the iframe may safely use allow-same-origin
 * (full SPA support). Unset → same-origin preview with a locked-down sandbox.
 */
export const PREVIEW_HOST = (process.env.NEXT_PUBLIC_CODING_PREVIEW_HOST || '').trim();
export const PREVIEW_CROSS_ORIGIN = PREVIEW_HOST.length > 0;
