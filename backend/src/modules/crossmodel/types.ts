// Model identifiers — Frontier: openai, grok, gemini | Open Source: glm, kimi, deepseek
export type ModelKey = 'openai' | 'grok' | 'gemini' | 'glm' | 'kimi' | 'deepseek';

// ── Shared patience/mode type union ───────────────────────────────────────────
// 2026-06-14: Single source of truth for all patience level modes. Previously
// this union was duplicated across 8+ files (validation, controller, service,
// types, pipeline, frontend API). When deep_research_all was added, all locations
// had to be updated manually — causing the bug where deep_research_all wasn't
// handled in cached mode resolution. Import this type everywhere instead.
//
// 2026-06-21 — patience levels restructured to 4 (L1=single_thinking, L2=thinking,
// L3=deep_research, L4=deep_research_all). The single-model FAST tier (`single`) and
// the legacy 3-models-fast tier (`fast`) are RETIRED: they are kept here only so
// stored chats and in-flight clients still validate, and are normalized to
// `single_thinking` at the controller boundary (see crossmodel.controller.ts).
// 2026-06-26 — added 'browser_agent': an open-source-only (GLM-5.2, reasoning_effort:"high")
// web-automation mode. It does NOT run the multi-model pipeline; the controller routes it
// straight to runBrowserAgentSession (cloud BrightData browser or the user's local Mac agent).
export const PATIENCE_MODES = ['single', 'single_thinking', 'fast', 'thinking', 'deep_research', 'deep_research_all', 'browser_agent'] as const;
export type PatienceMode = typeof PATIENCE_MODES[number];

// ── P4: 3 patience levels + Auto-the-router (not a level) ─────────────────────
// The message-level mode value 'auto' means "route this message with the
// heuristic Auto router" (platform/auto-router.ts) — and, since the owner's
// 2026-09-26 directive ("default all chats to auto even supervisors"), ALSO the
// STORED default of every chat: createChat (REST, platform tool, fleet /
// project supervisors, feeds, coding sessions, guest-claim migration) writes
// 'auto' unless a caller names a preset, and the runtime treats a stored 'auto'
// as "route per send" (human turns → the Auto router; machine wakes → the
// compute policy with the L2 preset as the fail-open fallback — see
// storedModeToPreset). A stored LEGACY level is that level (the preset
// fallback), so un-backfilled chats behave identically.
export const AUTO_MODE = 'auto' as const;
export type RoutableLevel = 'single_thinking' | 'thinking' | 'deep_research';
/** The preset a stored 'auto' falls back to when a run cannot route per send (machine wakes, queue drains, orphan re-fires): the L2 default — the same rule as compute-policy-gate normalizeDepthPreset('auto'), and what every UI-created chat stored before 2026-09-26. */
export const AUTO_MODE_PRESET: RoutableLevel = 'thinking';

/**
 * The PRESET a chat's STORED mode resolves to when the run cannot route it per
 * send (2026-09-26): 'auto' ⇒ AUTO_MODE_PRESET (L2); legacy ids alias forward
 * (`fast`/`single` → L1, `deep_research_all` → L3); a stored level is that
 * level; anything unrecognised ⇒ L1 (unchanged behaviour). Pure — the ONE
 * rule schedule.service (machine wakes), platform.service (machine sends into a
 * chat), the busy-queue drain and orphan recovery all apply.
 */
export function storedModeToPreset(mode: unknown): RoutableLevel {
  const m = normalizePatienceMode(String(mode ?? ''));
  if (m === AUTO_MODE) return AUTO_MODE_PRESET;
  if (m === 'thinking' || m === 'deep_research') return m;
  return 'single_thinking';
}

/**
 * THE controller-boundary patience-mode normalization (P4). Retired modes
 * alias to their successors on EVERY new intake; stored historical rows keep
 * their original values and keep rendering/working (the pipelines still
 * understand them — only the input boundaries collapse them):
 *   - 'single' / 'fast'        → 'single_thinking'  (retired FAST tiers, 2026-06)
 *   - 'deep_research_all' (L4) → 'deep_research'    (P4: one model set left ⇒ L4 ≡ L3)
 * Anything else (incl. 'browser_agent', 'code', 'auto') passes through
 * untouched — this helper aliases, it does NOT validate.
 */
export function normalizePatienceMode<T extends string>(mode: T): T | 'single_thinking' | 'deep_research' {
  if (mode === 'single' || mode === 'fast') return 'single_thinking';
  if (mode === 'deep_research_all') return 'deep_research';
  return mode;
}

export interface ModelResponse {
  model: ModelKey | string;
  response: string;
  time: number;
  error?: string;
  modelUsed?: string;       // Specific model/version used (e.g. 'glm-5.3', 'deepseek-flash')
  webSearchUsed?: boolean;  // Whether web search was active for this model
  toolCalls?: Array<{ name: string; args: Record<string, string> }>;  // MCP tools called by this model
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  /** Ticket 68916075: last-write stamp (ISO) — ≈ finalize time for coding-run assistant rows; absent on rows predating the field. */
  updatedAt?: string;
  metadata?: {
    /**
     * Shared-project author attribution (ticket f89d1213) — USER rows only:
     * the account that actually sent this message. Stamped at write time on
     * human-origin persists; legacy rows have no stamp and render as before.
     * Names resolve at read time (getChatById messageAuthors map) — never
     * denormalized here.
     */
    authorId?: string;
    /**
     * Attachment chips (ticket ac65d51e; inline images c6e8edda) — USER rows
     * only: filename + type stamped at send time, uploadId joining to the
     * durable ChatFile row, and fileId + mimeType injected at READ time by
     * getChatById so image chips can render inline via the authed byte
     * routes. All optional — legacy chips carry filename+type only.
     */
    attachments?: Array<{
      filename: string;
      type: string;
      uploadId?: string;
      fileId?: string;
      mimeType?: string;
    }>;
    mode: PatienceMode;
    webSearch?: boolean;
    modelSet?: 'frontier' | 'open_source'; // Which model set was used
    models: {
      // Frontier models
      openai?: ModelResponse;
      grok?: ModelResponse;
      gemini?: ModelResponse;
      // Open Source models
      glm?: ModelResponse;
      kimi?: ModelResponse;
      deepseek?: ModelResponse;
      // Allow any additional keys for future extensibility
      [key: string]: ModelResponse | undefined;
    };
    summary: string;
    totalTime: number;
  };
}

export interface ChatMode {
  mode: PatienceMode;
  webSearch: boolean;
}

// Events emitted by queryStream() during model execution
export type ThinkingEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'content_delta'; text: string }
  | { type: 'web_search_start'; text?: string; count?: number }
  | { type: 'web_search_done' }
  | { type: 'done' };

export interface StreamEvent {
  type: 'progress' | 'model-response' | 'chunk' | 'complete' | 'error' | 'thinking-summary' | 'canvas';
  data?: any;
  message?: string;
}
