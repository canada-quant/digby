/**
 * Account tools (2026-09-08) — "Digby operates Digby FOR the user".
 *
 * The chat agent (and the coding orchestrator) can set up the user's OWN
 * account features from inside a conversation: read what is already set up
 * (get_account_overview), keep durable facts (remember_fact/forget_fact), file
 * sources into a project's knowledge base (add_knowledge_url/add_knowledge_
 * note), work with canvases, push a Telegram
 * notification to the user (notify_user), set standing per-chat instructions,
 * and manage share links / the Telegram link. (Topic feeds were retired
 * 2026-10-20, ticket 43c24152 — a topic digest is schedule_message on a real
 * chat now; the list_feeds/create_feed tool pair is gone.)
 *
 * Registered through platform-tools.ts (PLATFORM_TOOL_SCHEMA = [...core,
 * ...ACCOUNT_TOOL_SCHEMA]; executeConfirmedPlatformTool's default branch
 * routes isAccountTool names here), so the tools flow to BOTH surfaces with
 * no extra wiring (coding/tools.ts CODING_TOOL_SCHEMA + the chat profile).
 *
 * Gating (mirrors platform-tools.ts's three tiers — the names live in the
 * dependency-free leaf platform-tool-names.ts):
 *   - READ (never gated): get_account_overview, list_memory,
 *     list_canvases, get_canvas, list_knowledge_documents, and
 *     telegram_connect_link — which, since the 2026-09-08 review, mints
 *     NOTHING: it returns the non-secret in-app Integrations page (see below),
 *     so it has no side effect and no reason to be gated (a confirmation on a
 *     read-only page pointer was pure friction against "set up Telegram and I
 *     can message you later").
 *   - MUTATING, non-consequential (auto-allowed in chat runs; reversible,
 *     owner-scoped): remember_fact, forget_fact, add_knowledge_url,
 *     add_knowledge_note, update_canvas, revoke_share_link, notify_user,
 *     set_chat_instructions. notify_user is deliberately executable in
 *     MACHINE-triggered runs without confirmation — "set up Telegram and I can
 *     message you later about this" is the whole point; it can only ever reach
 *     the user's OWN linked Telegram and is rate-capped.
 *     LIVE-USER-TURN REQUIRED (ctx.userTurnAt — the same anchor the
 *     consequential gate keys on; review 2026-09-08): remember_fact,
 *     forget_fact, set_chat_instructions and add_knowledge_url. A machine-
 *     triggered run (schedule firing, hook wake, webhook) executes with
 *     permissionMode 'auto' on injected web/Slack/ticket text, and each of
 *     these is a PERSISTENCE primitive that rides every future turn: a planted
 *     memory fact ([USER MEMORY] in every chat), a per-chat system prompt with
 *     highest precedence that no UI surfaces, or a frontier-web-search-backed
 *     URL ingestion into the project's RAG. Machine runs keep add_knowledge_
 *     note (no fetch; text the run already holds) under the same rate caps.
 *     Knowledge ingestion is additionally rate-capped per chat/hour + per
 *     user/day (KNOWLEDGE_* below) — a URL ingestion costs three frontier web
 *     searches plus embeddings in ingestion.service.
 *   - MUTATING + CONSEQUENTIAL (user-turn-anchored confirmation via the gate
 *     in platform-tools.ts): create_share_link (NEVER autonomous — it changes
 *     the account's security posture; see NEVER_AUTONOMOUS_TOOLS in
 *     platform-tools.ts). (create_feed was retired with the feed subsystem,
 *     ticket 43c24152, 2026-10-20.)
 *     telegram_connect_link NEVER handles the connect token (review
 *     2026-09-08): the t.me/<bot>?start=<token> URL is a bearer credential —
 *     whoever opens it binds THEIR Telegram to this account and from then on
 *     every message from that Telegram runs as the user (memory, connectors,
 *     notify_user pushes). A tool result is model-visible in a run that also
 *     holds web-egress tools, and the REST confirm path persists tool output
 *     on the pending_confirmations row — so the executor returns only the
 *     non-secret in-app Integrations page, where the user's OWN browser mints
 *     the link (POST /telegram/connect-link, exactly as before).
 *
 * IMPORT DISCIPLINE (the repo's known import-graph landmine, see .digby/notes/
 * learnings.md): this module is imported STATICALLY by platform-tools.ts, so
 * its static graph must stay exactly as mockable as platform-tools' own —
 * type-only imports, the platform-tool-names leaf, and platform.service (which
 * platform-tools.ts already imports statically). EVERYTHING heavy (prisma,
 * redis, logger, context.service, telegram.service,
 * ingestion.service, imessage.service, rate-limit.service, sharing.service)
 * loads via DYNAMIC import inside the handlers, which jest.mock still
 * intercepts. Adding a static heavy import here kills the jest worker of every
 * suite whose graph reaches platform-tools.ts without mocking that boundary.
 *
 * Result discipline: compact JSON strings the model can cite (ids first);
 * every refusal is a structured, actionable {ok:false, reason, …} string —
 * the executor never throws into the loop (a thrown error becomes a JSON
 * error envelope, never a dead run). Ownership is enforced with userId
 * filters in every prisma query.
 */

import type { ToolContext } from '../coding/tools';
import * as platform from './platform.service';
// Honest preview clip for staged-confirmation summaries (loopjacking
// representation fix, todo cd366b85 — see the leaf's header).
import { clipStagedPayloadPreview } from './confirmation-summary';
// audit 2026-10-06 T2-2: notify_user text is credential-scrubbed (leaf — only secret-scan statically).
import { scrubOutboundField, appendOutboundRedactionNote, recordOutboundRedaction } from './outbound-secret-scrub';
// Self-host setup hardening (2026-10-20): URL ingestion is a live fetch (pure leaf).
import { webSearchMissingOnInstance } from './instance-setup';
// "Unattended / Autonomous use" preset verdict (2026-10-28, owner card
// oq_f7955582): the ONE definition of device readiness a lane reads BEFORE it
// files any "please unlock <device>" card. Pure leaf — no Prisma/Redis.
import { unattendedReadyFor } from '../imessage/unattended-verdict';
// Pre-login input capability (2026-10-28, ticket c468f922): the typed fact a
// dispatch lane reads to REFUSE a locked device before spending a run on it —
// `prelogin_input: unavailable` was the ticket's own acceptance criterion.
import { preloginInputFor } from '../imessage/prelogin-capability';
import { normalizeRemoteAccess, remoteAccessReadyFor, remoteAccessVerdict } from '../imessage/remote-access-verdict';
// Brokered-session window (ticket c468f922, owner ruling 2026-10-29): folds a
// stored operator grant into the verdict so a session that outlived its window
// reports `stale` here too — the /agents payload reads the same fold, because
// two lane-facing surfaces disagreeing about readiness is the bug class.
import { withBrokeredSessionWindow } from '../imessage/brokered-session.store';

// ── Names ─────────────────────────────────────────────────────────────────────

/** The account tools, in schema order. Source of truth for isAccountTool.
 *  (Topic feeds list_feeds/create_feed were retired 2026-10-20, ticket
 *  43c24152 — a topic digest is schedule_message on a real chat now.) */
const ACCOUNT_TOOL_NAMES = [
  // read (telegram_connect_link is read-only since the 2026-09-08 review — it
  // returns the in-app connect page, never a token)
  'get_account_overview', 'list_memory', 'list_canvases', 'get_canvas', 'list_knowledge_documents',
  'telegram_connect_link',
  // mutating, non-consequential
  'remember_fact', 'forget_fact', 'add_knowledge_url', 'add_knowledge_note', 'update_canvas',
  'revoke_share_link', 'notify_user', 'set_chat_instructions',
  // email AS Digby (ticket 54f237bf) — machine-capable like notify_user, but
  // outbound to ANY address; instance rate-capped + recipient-prefix telemetry
  'send_email_as_digby',
  // mutating + consequential
  'create_share_link',
] as const;

const ACCOUNT_TOOL_SET = new Set<string>(ACCOUNT_TOOL_NAMES);

/** True if the tool name is one of the account tools (dispatched to executeAccountTool). */
export function isAccountTool(name: string): boolean {
  return ACCOUNT_TOOL_SET.has(name);
}

// ── Limits (one place, so descriptions + validation never drift) ───────────────

const MEMORY_KEY_MAX = 60;
const MEMORY_VALUE_MAX = 500;
const MEMORY_FACT_CAP = 500;
const KNOWLEDGE_DOCS_PER_PROJECT_CAP = 200;
const KNOWLEDGE_NAME_MAX = 120;
const KNOWLEDGE_NOTE_MIN = 40;
const KNOWLEDGE_NOTE_MAX = 200_000;
const CANVAS_CONTENT_MAX = 400_000;
const CANVAS_CONTENT_READ_CAP = 60_000;
const CANVAS_LIST_DEFAULT = 20;
const CANVAS_LIST_MAX = 50;
const CHAT_INSTRUCTIONS_MAX = 20_000;
const NOTIFY_MESSAGE_MAX = 3500;
const NOTIFY_USER_DAILY_CAP = 30;
const NOTIFY_CHAT_HOURLY_CAP = 5;
// Email AS Digby (ticket 54f237bf): bounds mirror email/digby-email.service.ts
// (the single source — keep the two in step).
const DIGBY_EMAIL_SUBJECT_MAX = 200;
const DIGBY_EMAIL_TEXT_MAX = 100_000;
// Knowledge ingestion caps (review 2026-09-08): add_knowledge_url fires
// ingestion.service.processDocument → analyzeUrlWithCrossModel = THREE frontier
// web-search calls + embeddings per URL, and a run that scraped an attacker
// page can be told "save these 150 URLs" — the 200-doc project cap was the
// only brake. Same counter pattern as notify_user (redis, UTC hour/day keys).
const KNOWLEDGE_CHAT_HOURLY_CAP = 10;
const KNOWLEDGE_USER_DAILY_CAP = 50;
/** Preview length list_canvases returns per row (computed in SQL — see the handler). */
const CANVAS_PREVIEW_CHARS = 200;
const SHARE_EXPIRY_CHOICES = [7, 30] as const;

/** Same wording schedule_message uses — the gate round-trip must survive the schema (learnings.md). */
const CONFIRMATION_ID_PARAM = {
  type: 'string',
  description: 'Omit on the first call. If the call returns needsConfirmation with a confirmationId, re-call with just this confirmationId (no other arguments needed — the staged arguments execute exactly as summarized) after the user confirms in a NEW message.',
};

// ── Schemas (OpenAI function-calling format, matches PLATFORM_TOOL_SCHEMA) ────
// Descriptions are DOCTRINE: each says WHEN (trigger phrases), WHAT, and the
// gating/refusal behavior — the model reads these as its operating rules.

export const ACCOUNT_TOOL_SCHEMA = [
  {
    type: 'function' as const,
    function: {
      name: 'get_account_overview',
      description: "What is set up for THIS user: integrations (connected + label), telegram {configuredOnInstance, linked, username}, pairedMac {paired, online, agentVersion, devices[{id, label, deviceName, platform, capabilities, online, agentVersion, isDefault, busy?, unattendedReady {enabled, ready, reason}}] — platform is the device's OS ('macos' | 'windows'; null = legacy Mac): never call a 'windows' device a Mac or route Mac-only work to it. unattendedReady = can this device run unattended, and the one reason it cannot — read it BEFORE filing any 'unlock <device>' card}, codingCredentials {count, envKeys — key NAMES only; each an env var in coding shells}, schedules.active, projects {count, withDocuments}, memory.facts, canvases.count, watchedResources [{id, label, reservationEndsAt, lastObservedAt, maxUnobservedMinutes}], deepResearch quota, and thisChat {id, title, projectId, hasWorkspace, mode, isSupervisor, instructions} (thisChat.instructions = the standing instructions, or null). Call this BEFORE offering a setup step ONLY when the [YOUR INTEGRATION STATUS] block in your context does not answer it; never just to decorate an offer. Read-only, never gated; fields degrade to null; anonymous users get {anonymous:true}.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_memory',
      description: "List the durable facts Digby remembers about this user ({facts: {key: value}, count}). WHEN: the user asks \"what do you know about me\" / \"what have you remembered\", or BEFORE remember_fact so you update an existing key instead of adding a near-duplicate. Read-only, never gated; anonymous users have no memory.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_canvases',
      description: "List the user's canvas artifacts (documents, code, html, mermaid, tables Digby produced): id, title, type, language, version, chatId, updatedAt, contentPreview (first 200 chars). Defaults to THIS chat; pass all:true for every chat of the user. Owner-only. WHEN: the user refers to \"the doc/table/code we made earlier\" — find its id here, then get_canvas / update_canvas. limit default 20, max 50.",
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'Only canvases of this chat (default: the current chat).' },
          all: { type: 'boolean', description: 'true = every canvas the user owns, across all chats.' },
          limit: { type: 'number', description: 'Rows (default 20, max 50).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_canvas',
      description: "Read ONE canvas in full (id, title, type, language, version, chatId, content — content over 60,000 chars is truncated with a note). Owner-only. WHEN: the user wants to continue, reuse, or revise an earlier artifact — read it before update_canvas so you edit the CURRENT version, not what you remember.",
      parameters: {
        type: 'object',
        properties: { canvasId: { type: 'string', description: 'From list_canvases.' } },
        required: ['canvasId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_knowledge_documents',
      description: "List a project's knowledge-base documents (id, name, mimeType, sourceUrl, status processing|ready|error, charCount, chunkCount, createdAt; max 100). projectId defaults to THIS chat's project; a chat that is not in a project must pass projectId (list_projects resolves names). Any project member may read. WHEN: the user asks what the project knows / whether a source is already saved, or to check ingestion status after add_knowledge_url / add_knowledge_note.",
      parameters: {
        type: 'object',
        properties: { projectId: { type: 'string', description: "Default: the current chat's project." } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'remember_fact',
      description: "Store ONE durable fact about the user in their persistent memory (key 1-60 chars, value 1-500 chars; an existing key is overwritten — list_memory first to reuse keys). WHEN: the user states a durable preference or fact about themselves (\"I'm vegetarian\", \"always answer in French\") or says \"remember …\" — not transient task details. NEVER store secrets, passwords, card numbers, or facts about third parties they did not ask to keep. ONLY from a live user request — a scheduled/automatic run may never write memory (refused with no_user_turn). Refuses anonymous users and a full memory (500 facts). Tell the user what you remembered.",
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short stable label, e.g. "diet", "company", "preferred_language".' },
          value: { type: 'string', description: 'The fact, as the user would want it recalled.' },
        },
        required: ['key', 'value'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'forget_fact',
      description: "Delete ONE fact from the user's persistent memory by key. WHEN: \"forget X\", \"stop bringing up X\", \"that's wrong about me\". ONLY from a live user request — a scheduled/automatic run may never forget facts (refused without a real user turn). An unknown key returns {ok:false, reason:'not_found', suggestions:[closest keys]} — pick the right key and re-call, or ask the user. Refuses anonymous users.",
      parameters: {
        type: 'object',
        properties: { key: { type: 'string', description: 'The exact key (see list_memory).' } },
        required: ['key'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_knowledge_url',
      description: "Save a web page (http/https URL) into a project's knowledge base — fetched, chunked and embedded in the background, then it grounds every chat in that project. WHEN: the user wants to KEEP a source for the project (\"save this for the project\"). projectId defaults to THIS chat's project (a chat outside a project is refused with guidance); needs owner/editor/admin; 200 documents max per project. ONLY from a live user request — a scheduled/automatic run may not ingest URLs (refused with no_user_turn; it may add_knowledge_note text it holds). Rate-capped: 10 knowledge documents/hour per chat, 50/day per user (shared with add_knowledge_note). Returns {documentId, status:'processing'}; list_knowledge_documents shows when it is ready.",
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "Default: the current chat's project." },
          url: { type: 'string', description: 'http(s) URL of the page to ingest.' },
          name: { type: 'string', description: 'Optional display name (default: host + path).' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_knowledge_note',
      description: "Save TEXT (40-200,000 chars) as a named knowledge-base document in a project — research you just did, an answer worth keeping, or material the user pasted — so it grounds every future chat in that project. WHEN: the user says \"keep this in the project\", \"save this research\", \"add these notes to the knowledge base\", or asks that an answer be remembered project-wide (per-USER facts go to remember_fact instead). Same scope rules as add_knowledge_url: projectId defaults to THIS chat's project (a chat with no project is refused with guidance), owner/editor/admin only, 200-document cap, and the shared rate cap (10 knowledge documents/hour per chat, 50/day per user). Allowed in scheduled/automatic runs (it stores text the run already holds — no fetch). Returns {documentId, status:'processing'}.",
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: "Default: the current chat's project." },
          name: { type: 'string', description: 'Document title (1-120 chars).' },
          text: { type: 'string', description: 'The content to store (40-200,000 chars).' },
        },
        required: ['name', 'text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_canvas',
      description: "Rewrite an existing canvas's content and/or title (owner-only; content ≤ 400,000 chars; the version increments). WHEN: the user asks to change, extend, or fix a document/code/table Digby produced earlier (\"update the plan doc\", \"fix the SQL in that canvas\") — read it with get_canvas first and pass the FULL new content (this replaces, it does not patch). The canvas panel shows the new version when the user reopens it.",
      parameters: {
        type: 'object',
        properties: {
          canvasId: { type: 'string', description: 'From list_canvases / get_canvas.' },
          content: { type: 'string', description: 'The complete new content (replaces the old).' },
          title: { type: 'string', description: 'New title (optional).' },
        },
        required: ['canvasId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'revoke_share_link',
      description: "Revoke (deactivate) the public share link of a chat so the public page stops working (default: THIS chat; owner-only). WHEN: \"unshare this\", \"turn off the share link\", \"make this private again\". Returns {revoked:true} or {revoked:false} when the chat never had a link. Reversible — create_share_link re-activates the same link.",
      parameters: {
        type: 'object',
        properties: { chatId: { type: 'string', description: 'Default: the current chat.' } },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'notify_user',
      description: "Push a short message (1-3500 chars) to the user's OWN linked Telegram — never to anyone else. WHEN: a scheduled/background run finished something the user asked to be told about, or they asked to be pinged when something happens. It does NOT replace the chat answer — still write the full answer in the chat. Works in machine-triggered runs WITHOUT confirmation. If the result says telegram_not_linked, call telegram_connect_link (or point to Account → Integrations → Telegram) — never pretend a notification was sent. Rate-capped: 30/day per user, 5/hour per chat.",
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The notification text (plain text; a Digby footer naming this chat is appended).' },
          channel: { type: 'string', enum: ['telegram', 'auto'], description: "Delivery channel (default 'auto' = the linked channel; Telegram today)." },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'send_email_as_digby',
      description: "Send an email AS DIGBY from its own address (digby@digby.example.com) — NOT from the user's Gmail (that is gmail_send_email). Works in machine-triggered runs WITHOUT confirmation (a digest firing or a monitor can send one). WHEN: the user asked to be emailed — now or as the end of a schedule. One recipient per call (to, optional cc), plain-text body; for notifications/digests the owner asked for, never for mass/bulk sends. Rate cap 30/hour per instance. If the result says not configured, tell the user the instance owner must configure Digby's email sender, and do NOT claim an email was sent.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address (exactly one).' },
          cc: { type: 'string', description: 'Optional single CC address.' },
          subject: { type: 'string', description: `Subject line (≤ ${DIGBY_EMAIL_SUBJECT_MAX} chars).` },
          text: { type: 'string', description: `Plain-text body (≤ ${DIGBY_EMAIL_TEXT_MAX} chars).` },
        },
        required: ['to', 'subject', 'text'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_chat_instructions',
      description: "Set standing instructions for a chat (a custom system prompt appended with highest precedence to every future turn; ≤ 20,000 chars; '' clears). chatId omitted = THIS chat: owner-only and ONLY from a live user request — a scheduled/automatic run may never set its own instructions (refused with no_user_turn). chatId = ANOTHER chat you own: CONSEQUENTIAL — a confirmation card unless this chat holds an autonomy grant for it. This call REPLACES the whole text: read it with get_chat_instructions and extend it. Supervisor chats are refused. WHEN: \"for this chat always …\" or a standing rule a lane must keep. Project-wide rules belong in update_project systemPrompt; facts about the user in remember_fact. Audited.",
      parameters: {
        type: 'object',
        properties: {
          instructions: { type: 'string', description: "The standing instructions ('' clears them)." },
          chatId: { type: 'string', description: 'Another chat you own (omit for this chat).' },
        },
        required: ['instructions'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_share_link',
      description: "Create (or re-activate) a PUBLIC read-only share link for a chat — anyone with the URL can read the whole transcript, no login. Default: THIS chat; owner-only; coding chats are refused (their transcripts are not shareable). expiresInDays must be 7 or 30, or omitted = never expires. WHEN: \"share this chat\", \"give me a link to this conversation\", \"make this public\". CONSEQUENTIAL and NEVER autonomous: it always needs the user's explicit confirmation in a new message — even in auto-mode coding sessions and regardless of any autonomy grant — because it changes who can read the user's data. Returns {shareUrl, expiresAt}; show the URL to the user as a markdown link.",
      parameters: {
        type: 'object',
        properties: {
          chatId: { type: 'string', description: 'Default: the current chat.' },
          expiresInDays: { type: 'number', enum: [7, 30], description: 'Expiry in days (7 or 30). Omit for a link that never expires.' },
          confirmationId: CONFIRMATION_ID_PARAM,
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'telegram_connect_link',
      description: "How the user connects Telegram to THIS account: returns connectPage — the in-app Account → Integrations page where the user's OWN browser mints the one-time connect link (a bearer credential, so it is NEVER returned to you or written into the chat). Afterwards notify_user works and they can chat with Digby from Telegram. WHEN: the user wants to be messaged later or asks to connect Telegram, and their status shows it is not linked. Refuses when the instance has no Telegram bot (not_configured) or it is already linked (already_linked → use notify_user). READ-ONLY, never gated, no confirmation. Show connectPage as a markdown link: press 'Connect Telegram' there, then Start in Telegram.",
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/** JSON result the model can cite; refusals carry ok:false + a reason code + guidance. */
function j(obj: unknown): string {
  return JSON.stringify(obj, null, 1);
}

function refuse(tool: string, reason: string, message: string, extra: Record<string, unknown> = {}): string {
  return j({ ok: false, tool, reason, message, ...extra });
}

/**
 * Anonymous chat runs carry the sentinel userId 'anonymous' (chat-agent.service
 * `runUserId = userId || 'anonymous'`); every account tool that touches the
 * user's own data refuses them with the same upsell line.
 */
function isAnonymous(ctx: ToolContext): boolean {
  return !ctx.userId || ctx.userId === 'anonymous';
}

const ANON_NOTE = 'a free account unlocks memory, schedules, knowledge bases, Telegram notifications and more — the user can sign up in a few seconds';

function refuseAnonymous(tool: string): string {
  return refuse(tool, 'anonymous', `${tool} needs a signed-in user — ${ANON_NOTE}. Do not retry this run; mention the option in your answer.`);
}

/**
 * Lazy logger (same reason platform-tools.ts's logPlatformTools exists): a
 * static utils/logger import would drag config/env into every suite graph
 * reaching platform-tools. Logging must never break a tool.
 */
async function logAccountTools(level: 'info' | 'warn', msg: string): Promise<void> {
  try {
    const logger = (await import('../../../utils/logger')).default;
    logger[level](msg);
  } catch { /* never let logging fail a tool */ }
}

/** Lazy prisma — the same dynamic-import boundary pending-confirmations.ts uses. */
async function db() {
  return (await import('../../../config/database')).default;
}

/**
 * "This chat" default: ctx.sessionId IS the current chat on BOTH surfaces (a
 * coding session is a chat — the same identity file_feedback relies on).
 */
function targetChatId(ctx: ToolContext, args: any): string {
  const explicit = typeof args?.chatId === 'string' ? args.chatId.trim() : '';
  return explicit || ctx.sessionId;
}

/**
 * Project scope resolution for the knowledge tools. chat-agent.service
 * launches EVERY chat-surface run with the sentinel projectId 'chat'
 * (`ctx.projectId || 'chat'` — see projectScopedRun in platform-tools.ts), so
 * the sentinel is NOT a project: an ungrouped chat must pass projectId (or be
 * moved into a project first). An explicit args.projectId of 'chat' is the
 * same sentinel echoed back by the model — refused identically.
 */
function resolveProjectId(ctx: ToolContext, args: any, tool: string, guidance: string): { projectId: string } | { refusal: string } {
  const explicit = typeof args?.projectId === 'string' ? args.projectId.trim() : '';
  if (explicit && explicit !== 'chat') return { projectId: explicit };
  const fromCtx = ctx.projectId && ctx.projectId !== 'chat' ? ctx.projectId : '';
  if (fromCtx) return { projectId: fromCtx };
  return { refusal: refuse(tool, 'no_project', `This chat is not in a project, so there is no knowledge base to target. ${guidance}`) };
}

const EDITOR_ROLES = new Set(['owner', 'editor', 'admin']);

/** Days-from-now → Date; null = never. */
function shareExpiryLabel(expiresInDays: unknown): string {
  return typeof expiresInDays === 'number' && expiresInDays > 0 ? `in ${expiresInDays} days` : 'never';
}

// Rate-slot helpers live in platform/rate-slots.ts (the leaf the image-generation
// work added, 2026-09-24); re-exported here so existing importers keep working.
export { rateKeys, consumeRateSlots } from './rate-slots';
import { HOUR_KEY_TTL, DAY_KEY_TTL, rateKeys, consumeRateSlots } from './rate-slots';
/** Knowledge caps shared with housekeeping-tools.ts add_knowledge_file (T4a, 2026-09-24). */
export const KNOWLEDGE_CAPS = { chatHourly: KNOWLEDGE_CHAT_HOURLY_CAP, userDaily: KNOWLEDGE_USER_DAILY_CAP, docsPerProject: KNOWLEDGE_DOCS_PER_PROJECT_CAP, nameMax: KNOWLEDGE_NAME_MAX, hourKeyTtl: HOUR_KEY_TTL, dayKeyTtl: DAY_KEY_TTL } as const;

/**
 * The in-app page where the user's OWN browser mints the Telegram connect
 * link (IntegrationsTab → POST /telegram/connect-link). Same first-origin
 * rule sharing.service's shareUrlForToken uses. Contains NO credential.
 */
function accountIntegrationsUrl(): string {
  const host = process.env.FRONTEND_URL?.split(',')[0] ?? 'http://crossmodel.cozz';
  return `${host}/account?tab=integrations`;
}

/**
 * Best-effort audit row (Activity, resource 'platform') — the same trail the
 * consequential platform tools leave (platform-tools.ts send_to_instance,
 * platform.service). An audit hiccup must never fail the tool.
 */
async function auditAccountAction(userId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    const prisma = await db();
    await (prisma as any).activity.create({ data: { userId, action, resource: 'platform', metadata } });
  } catch (err: any) {
    void logAccountTools('warn', `account-tools: audit row ${action} failed for user ${userId}: ${err?.message ?? err}`);
  }
}

/** Shared refusal for the tools that only a live user turn may run. */
function refuseNoUserTurn(tool: string, message: string): string {
  return refuse(tool, 'no_user_turn', message);
}

// ── Staging hook (called from gateConsequentialPlatformTool) ──────────────────

export type AccountStaging =
  | { ok: true; args: any; summary: string }
  | { ok: false; error: string };

/**
 * Staging-time preparation for the two CONSEQUENTIAL account tools — the
 * same "never let the user confirm a doomed action" rule start_coding_session
 * follows (feedback 2026-08-16). Runs BEFORE registerPendingConfirmation:
 *   - defaults are stamped INTO the staged args (chatId = this chat,
 *     intervalMinutes = daily) so the WYSIWYG confirm executes exactly what
 *     the summary said;
 *   - argument bounds and account preconditions (owner/coding-chat for share
 *     links, feed caps) are checked
 *     here so the refusal reaches the model NOW, not after the user clicks
 *     Confirm;
 *   - the summary is upgraded with the chat TITLE when readable (id-only on a
 *     read failure — best effort, never a refusal).
 * Every heavy dep is a dynamic import (see the module header).
 */
export async function stageAccountTool(ctx: ToolContext, name: string, args: any, baseSummary: string): Promise<AccountStaging> {
  try {
    if (isAnonymous(ctx)) return { ok: false, error: refuseAnonymous(name) };
    switch (name) {
      case 'create_share_link': {
        const chatId = targetChatId(ctx, args);
        const exp = args?.expiresInDays;
        if (exp !== undefined && exp !== null && !SHARE_EXPIRY_CHOICES.includes(Number(exp) as 7 | 30)) {
          return { ok: false, error: refuse(name, 'invalid_expiry', 'expiresInDays must be 7 or 30, or omitted for a link that never expires.') };
        }
        const expiresInDays = exp === undefined || exp === null ? undefined : Number(exp);
        // Owner + coding-chat preconditions NOW (a confirmed-then-refused card
        // is the doomed-action class). Read failures degrade to the id-only
        // summary — the executor re-checks everything anyway.
        let title: string | null = null;
        try {
          const prisma = await db();
          const chat = await prisma.crossModelChat.findFirst({ where: { id: chatId, userId: ctx.userId }, select: { id: true, title: true } });
          if (!chat) {
            return { ok: false, error: refuse(name, 'not_found', `Chat "${chatId}" was not found among the chats you own — only the owner can share a chat. Copy the exact id from list_chats (omit chatId to share THIS chat).`) };
          }
          const coding = await (prisma as any).chatCodingState.findUnique({ where: { id: chatId }, select: { id: true } }).catch(() => null);
          if (coding) {
            return { ok: false, error: refuse(name, 'coding_chat', 'Coding chats cannot be shared publicly (their transcripts live in the coding session and may contain tool output from the owner\'s environment). Nothing was staged.') };
          }
          title = chat.title;
        } catch { /* best effort — id-only summary */ }
        const staged = { ...args, chatId, ...(expiresInDays !== undefined ? { expiresInDays } : {}) };
        // Plain clip here (adversarial-review finding, todo cd366b85): the chat
        // TITLE is ambient DB context, not staged payload — the card's actual
        // payload (chatId + expiresInDays) is shown in full, and the
        // "FULL staged text executes" marker would be FALSE for this field.
        const label = title ? `"${title.replace(/\s+/g, ' ').slice(0, 80)}" (${chatId})` : chatId;
        return { ok: true, args: staged, summary: `Create a PUBLIC read-only share link for chat ${label} (expires ${shareExpiryLabel(expiresInDays)}). Anyone with the URL can read the whole transcript.` };
      }
      default:
        return { ok: true, args, summary: baseSummary };
    }
  } catch (err: any) {
    return { ok: false, error: refuse(name, 'error', `Could not stage ${name}: ${err?.message ?? String(err)}`) };
  }
}

// ── Executor ──────────────────────────────────────────────────────────────────

/**
 * Execute an account tool as the run's user (ctx.userId). Called from
 * executeConfirmedPlatformTool — consequential tools arrive here AFTER the
 * gate (with their STAGED args). Never throws: an unexpected error becomes a
 * structured error envelope so the agent loop keeps going.
 */
export async function executeAccountTool(ctx: ToolContext, name: string, args: any): Promise<string> {
  try {
    return await dispatch(ctx, name, args ?? {});
  } catch (err: any) {
    const message = err?.message ?? String(err);
    void logAccountTools('warn', `account-tools: ${name} failed for user ${ctx.userId} (chat ${ctx.sessionId}): ${message}`);
    return refuse(name, 'error', `${name} failed: ${message}. Nothing was changed; tell the user if this blocks what they asked for.`);
  }
}

async function dispatch(ctx: ToolContext, name: string, args: any): Promise<string> {
  const userId = ctx.userId;
  switch (name) {
    // ── READ ────────────────────────────────────────────────────────────────
    case 'get_account_overview': {
      if (isAnonymous(ctx)) return j({ anonymous: true, note: ANON_NOTE });
      const prisma = await db();
      const p = (prisma as any);
      // EVERY read individually degraded — one failing table never fails the
      // snapshot (a stale integration model, a redis hiccup in the quota…).
      const nul = () => null;
      const [
        googleRow, googleCountRaw, githubRow, xRow, xeroRow, plaidRow, slackRow, asanaRow,
        telegramRow, tgSvc, agent, imessageSvc, schedules, shellCredNames, projectCount, docProjects,
        memoryFacts, canvasCount, watchedRows, quota, chat, coding,
      ] = await Promise.all([
        p.googleOAuthToken.findFirst({ where: { userId }, select: { email: true, label: true } }).catch(nul),
        p.googleOAuthToken.count({ where: { userId } }).catch(() => 0),
        p.gitHubOAuthToken.findFirst({ where: { userId }, select: { username: true, scopes: true } }).catch(nul),
        p.xOAuthToken.findFirst({ where: { userId }, select: { screenName: true } }).catch(nul),
        p.xeroOAuthToken.findFirst({ where: { userId }, select: { orgName: true } }).catch(nul),
        p.plaidAccessToken.findFirst({ where: { userId }, select: { institutionName: true } }).catch(nul),
        p.slackOAuthToken.findFirst({ where: { userId }, select: { teamName: true } }).catch(nul),
        p.asanaOAuthToken.findFirst({ where: { userId }, select: { asanaName: true } }).catch(nul),
        p.telegramLink.findFirst({ where: { userId }, select: { username: true } }).catch(nul),
        import('../telegram/telegram.service').catch(nul),
        import('../imessage/imessage.service').then((m) => m.listAgents(userId)).catch(nul),
        import('../imessage/imessage.service').catch(nul),
        platform.listSchedules({ userId }).catch(nul),
        // Ticket c02b85bf: names-only view of the coding credential store —
        // same source as the integration-status block (getCredentialEnv keys),
        // so a chat agent consulting the overview sees which keys exist.
        // Degrades to null (never []) on a failed read — an empty array would
        // read as "no credentials stored" when the read merely failed.
        import('../coding/credentials.service').then((m) => m.listShellCredentialNames(userId)).catch(() => null),
        p.crossModelProject.count({ where: { userId } }).catch(nul),
        p.projectDocument.findMany({ where: { userId, projectId: { not: null } }, distinct: ['projectId'], select: { projectId: true } }).catch(nul),
        import('../context.service').then((m) => m.default.getUserMemory(userId)).catch(nul),
        p.canvasDocument.count({ where: { userId } }).catch(nul),
        // Ticket 251e9329 (2026-09-13): the observe_resource refusal advertises
        // "list via get_account_overview" — this read is what makes that real.
        // Same degradation contract as every other overview field.
        p.watchedResource.findMany({
          where: { userId },
          orderBy: { createdAt: 'asc' },
          select: { id: true, label: true, reservationEndsAt: true, lastObservedAt: true, maxUnobservedMinutes: true },
        }).catch(nul),
        import('../rate-limit.service').then((m) => m.checkDeepResearchQuota(userId)).catch(nul),
        // systemPrompt = the standing instructions set_chat_instructions writes
        // (review 2026-09-08: no UI surfaces the per-chat field — this is the
        // one place the user/model can SEE and therefore clear it).
        p.crossModelChat.findFirst({ where: { id: ctx.sessionId, userId }, select: { id: true, title: true, projectId: true, mode: true, isSupervisor: true, systemPrompt: true } }).catch(nul),
        p.chatCodingState.findUnique({ where: { id: ctx.sessionId }, select: { id: true } }).catch(nul),
      ]);
      const googleCount = typeof googleCountRaw === 'number' ? googleCountRaw : 0;
      // cu-diag 2026-09-25 fix #6: the computer-use BUSY state per paired
      // device (who holds the use-lock: chat id + lane + since) so the model
      // can see "the Mac is being driven by lane X" before it dispatches a
      // computer_task. Degraded to {} on any failure (never fails the snapshot);
      // a free device contributes no key, so the legacy device shape is intact.
      const busyByDevice: Record<string, { holderChatId: string | null; holderLane: string | null; since: string | null }> = {};
      try {
        const agentsForBusy: any[] = Array.isArray(agent) ? agent : [];
        if (agentsForBusy.length > 0) {
          const lock = await import('../computer-agent/use-lock');
          await Promise.all(agentsForBusy.map(async (a) => {
            try {
              if (!(await lock.computerUseLockHeld(userId, a.id))) return;
              const h = await lock.describeComputerUseHolder(userId, a.id);
              busyByDevice[a.id] = { holderChatId: h?.chatId ?? null, holderLane: h?.lane ?? null, since: h?.since ?? null };
            } catch { /* this device's busy read degraded alone */ }
          }));
        }
      } catch { /* the lock module/redis is unavailable — no busy keys */ }
      // BROKERED-SESSION verdicts (ticket c468f922, owner ruling 2026-10-29).
      // Precomputed HERE because the device map below is synchronous: the
      // session-window fold needs a Redis read, so it cannot happen inside a
      // plain `.map()`. Degraded to a plain verdict per device on any failure —
      // a session store hiccup must never fail the whole overview.
      //
      // Both lane-facing surfaces (this one and the /agents payload) read the
      // SAME fold, for the same reason `preloginHelper` passes the policy to
      // both: two surfaces disagreeing about device readiness is the bug class.
      const remoteAccessByDevice: Record<string, ReturnType<typeof remoteAccessVerdict>> = {};
      try {
        await Promise.all((Array.isArray(agent) ? agent : []).map(async (a: any) => {
          try {
            remoteAccessByDevice[a.id] = remoteAccessVerdict(
              await withBrokeredSessionWindow(a.id, normalizeRemoteAccess(a.remoteAccess)),
            );
          } catch { /* this device's verdict degraded alone */ }
        }));
      } catch { /* no device verdicts — the map falls back below */ }
      const overview = {
        integrations: {
          google: { connected: !!googleRow, accounts: googleRow ? Math.max(1, googleCount) : 0, label: googleRow?.label ?? googleRow?.email ?? null },
          github: { connected: !!githubRow, username: githubRow?.username ?? null, repoScope: githubRow ? Array.isArray(githubRow.scopes) && githubRow.scopes.includes('repo') : null },
          x: { connected: !!xRow, screenName: xRow?.screenName ?? null },
          xero: { connected: !!xeroRow, orgName: xeroRow?.orgName ?? null },
          plaid: { connected: !!plaidRow, institutionName: plaidRow?.institutionName ?? null },
          slack: { connected: !!slackRow, teamName: slackRow?.teamName ?? null },
          asana: { connected: !!asanaRow, asanaName: asanaRow?.asanaName ?? null },
        },
        telegram: {
          configuredOnInstance: !!(tgSvc && tgSvc.isConfigured() && tgSvc.getBotUsername()),
          linked: !!telegramRow,
          username: telegramRow?.username ?? null,
        },
        // Ticket c02b85bf: names only — values are write-only (the store never
        // returns them) and these names mirror exactly what a spawned coding
        // session's shell receives. Null (whole section) on a failed read.
        ...(Array.isArray(shellCredNames)
          ? { codingCredentials: { count: shellCredNames.length, envKeys: shellCredNames } }
          : { codingCredentials: null }),
        pairedMac: (() => {
          // Multi-Mac (2026-09-24): keep the legacy aggregate shape (paired/
          // online/agentVersion — the default Mac) for single-Mac callers, and
          // add the full list. `agent` here is listAgents()'s array (or null on
          // a failed read — the degradation contract).
          // Ticket 40d33d6f: each device ALSO carries platform/capabilities —
          // the agent-advertised OS ('macos' | 'windows'; null = a legacy
          // pre-W0 row → a Mac). Without it this list showed a paired Windows
          // PC as a Mac (the OS field never reached the fleet device list).
          const agents: any[] = Array.isArray(agent) ? agent : [];
          const primary = agents.find((a) => a?.isDefault) ?? agents[0] ?? null;
          return {
            paired: agents.length > 0,
            online: !!(primary && imessageSvc && imessageSvc.isOnline(primary.lastSeenAt)),
            agentVersion: primary?.agentVersion ?? null,
            ...(agents.length > 0
              ? {
                  count: agents.length,
                  devices: agents.map((a) => ({
                    id: a.id,
                    label: a.label,
                    deviceName: a.deviceName ?? null,
                    // 40d33d6f: the OS this device runs — 'windows' renders as
                    // a Windows PC, null/absent = a legacy Mac row.
                    platform: a?.platform ?? null,
                    capabilities: Array.isArray(a?.capabilities) ? a.capabilities : [],
                    online: !!(imessageSvc && imessageSvc.isOnline(a.lastSeenAt)),
                    agentVersion: a.agentVersion ?? null,
                    isDefault: !!a.isDefault,
                    // "Unattended / Autonomous use" verdict (2026-10-28, owner
                    // card oq_f7955582): CAN this device start work unattended,
                    // and if not the ONE reason. Read it BEFORE filing any
                    // "unlock <device>" owner card — a device that is merely
                    // not configured is fixable by the user in one step, so a
                    // lock-screen card against it is noise (three such cards
                    // landed in one day). NEVER shows "ready" for a device that
                    // never advertised (an honest unknown).
                    unattendedReady: unattendedReadyFor(a),
                    // Pre-login input capability (2026-10-28, ticket
                    // c468f922): CAN input be delivered to this device while
                    // no user session exists, and is it sitting at a lock /
                    // login screen right now. A scheduler must read
                    // `blockedNow: true` and NOT dispatch (a locked device
                    // cannot accept an event — macOS refuses events from a
                    // user-session app at loginwindow, and the Windows secure
                    // desktop is unreachable). `status` is 'unavailable' in
                    // this build: no privileged pre-login helper ships, which
                    // is the typed fact lanes fail fast on.
                    prelogin: preloginInputFor(a),
                    // BROKERED REMOTE ACCESS (ticket c468f922, OWNER RULING
                    // 2026-10-29 on oq_b5118c38: "can we do option three but a
                    // little more secure like how it's just like TeamViewer").
                    // SEPARATE from `prelogin` above, deliberately: prelogin
                    // says whether THIS run's input can land at a login window
                    // (still no), this says whether a hardened operator channel
                    // exists. `ready` requires enabled + tunnel-bound + zero
                    // blockers, so a device that merely advertises nothing is
                    // an honest "not configured" and never a false ready.
                    // `remoteAccess` — the session-window fold (see the
                    // precomputed map above), so an overrun operator session
                    // reports `stale` HERE exactly as it does in /agents.
                    remoteAccess: remoteAccessByDevice[a.id] ?? remoteAccessReadyFor(a),
                    // cu-diag fix #6: present ONLY while a computer-use session
                    // holds this device (holder chat id + lane + since).
                    ...(busyByDevice[a.id] ? { busy: busyByDevice[a.id] } : {}),
                  })),
                }
              : {}),
          };
        })(),
        schedules: { active: Array.isArray(schedules) ? schedules.filter((s: any) => s?.enabled).length : null },
        projects: { count: typeof projectCount === 'number' ? projectCount : null, withDocuments: Array.isArray(docProjects) ? docProjects.length : null },
        memory: { facts: memoryFacts && typeof memoryFacts === 'object' ? Object.keys(memoryFacts).length : null },
        canvases: { count: typeof canvasCount === 'number' ? canvasCount : null },
        // Ticket 251e9329: the registry the observe_resource refusal points at —
        // ids + labels + the two clock fields an observation-duty lane needs.
        watchedResources: Array.isArray(watchedRows) ? watchedRows.map((r: any) => ({
          id: String(r?.id ?? ''),
          label: String(r?.label ?? ''),
          reservationEndsAt: r?.reservationEndsAt instanceof Date ? r.reservationEndsAt.toISOString() : (r?.reservationEndsAt ?? null),
          lastObservedAt: r?.lastObservedAt instanceof Date ? r.lastObservedAt.toISOString() : (r?.lastObservedAt ?? null),
          maxUnobservedMinutes: typeof r?.maxUnobservedMinutes === 'number' ? r.maxUnobservedMinutes : null,
        })) : null,
        deepResearch: quota ?? null,
        thisChat: {
          id: ctx.sessionId,
          title: chat?.title ?? null,
          projectId: chat?.projectId ?? null,
          hasWorkspace: !!coding,
          mode: chat?.mode ?? null,
          isSupervisor: !!chat?.isSupervisor,
          instructions: typeof chat?.systemPrompt === 'string' && chat.systemPrompt.trim()
            ? { chars: chat.systemPrompt.length, preview: chat.systemPrompt.replace(/\s+/g, ' ').trim().slice(0, 200) }
            : null,
        },
      };
      return j(overview);
    }

    case 'list_memory': {
      if (isAnonymous(ctx)) return j({ facts: {}, count: 0, anonymous: true, note: ANON_NOTE });
      const contextService = (await import('../context.service')).default;
      const facts = await contextService.getUserMemory(userId);
      // `since` (2026-10-20, additive): key → YYYY-MM-DD the current value was stored
      // (memory/fact-versions.ts) — absent when FACT_VERSIONS_DISABLED=1 or no date is known.
      const { getFactMeta, factSinceDates } = await import('../memory/fact-versions');
      const since = Object.fromEntries(Object.entries(factSinceDates(await getFactMeta(userId))).filter(([k]) => Object.prototype.hasOwnProperty.call(facts, k)));
      return j({ facts, count: Object.keys(facts).length, ...(Object.keys(since).length ? { since } : {}) });
    }

    case 'list_canvases': {
      if (isAnonymous(ctx)) return j({ canvases: [], count: 0, anonymous: true, note: ANON_NOTE });
      const limit = Math.min(CANVAS_LIST_MAX, Math.max(1, Number(args?.limit) || CANVAS_LIST_DEFAULT));
      const all = args?.all === true;
      const chatId = all ? undefined : targetChatId(ctx, args);
      const prisma = await db();
      // NO `content` in the select (review 2026-09-08): a canvas holds up to
      // 400,000 chars, so 50 rows pulled ~20 MB into the backend to cut 50
      // 200-char previews on every list call in the agent loop. The previews
      // come from ONE follow-up raw query that truncates IN SQL (LEFT()) —
      // best effort: a preview failure degrades to '' and the list still works.
      const rows = await prisma.canvasDocument.findMany({
        where: { userId, ...(chatId ? { chatId } : {}) },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, title: true, type: true, language: true, version: true, chatId: true, updatedAt: true },
      });
      const previews = new Map<string, string>();
      if (rows.length) {
        try {
          const ids = rows.map((c) => c.id);
          const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
          const previewRows = await prisma.$queryRawUnsafe<Array<{ id: string; preview: string | null }>>(
            `SELECT id, LEFT(content, $1::int) AS preview FROM canvas_documents WHERE id IN (${placeholders})`,
            CANVAS_PREVIEW_CHARS, ...ids,
          );
          for (const r of previewRows) previews.set(r.id, r.preview ?? '');
        } catch (err: any) {
          void logAccountTools('warn', `account-tools: list_canvases preview query failed (listing without previews): ${err?.message ?? err}`);
        }
      }
      const canvases = rows.map((c) => ({
        id: c.id, title: c.title, type: c.type, language: c.language ?? null, version: c.version, chatId: c.chatId,
        updatedAt: c.updatedAt, contentPreview: previews.get(c.id) ?? '',
      }));
      return j({ canvases, count: canvases.length, scope: all ? 'all' : `chat ${chatId}`, ...(canvases.length === limit ? { truncated: true } : {}) });
    }

    case 'get_canvas': {
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const canvasId = String(args?.canvasId ?? '').trim();
      if (!canvasId) return refuse(name, 'invalid_args', 'get_canvas requires canvasId (from list_canvases).');
      const prisma = await db();
      const c = await prisma.canvasDocument.findFirst({ where: { id: canvasId, userId } });
      if (!c) return refuse(name, 'not_found', `No canvas "${canvasId}" is owned by you. Copy the exact id from list_canvases.`);
      const truncated = c.content.length > CANVAS_CONTENT_READ_CAP;
      return j({
        id: c.id, title: c.title, type: c.type, language: c.language ?? null, version: c.version, chatId: c.chatId,
        createdAt: c.createdAt, updatedAt: c.updatedAt,
        content: truncated ? c.content.slice(0, CANVAS_CONTENT_READ_CAP) : c.content,
        ...(truncated ? { truncated: true, note: `content truncated to ${CANVAS_CONTENT_READ_CAP} of ${c.content.length} chars` } : {}),
      });
    }

    case 'list_knowledge_documents': {
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const scope = resolveProjectId(ctx, args, name, 'Pass projectId explicitly — list_projects resolves project names to ids.');
      if ('refusal' in scope) return scope.refusal;
      const access = await platform.getProjectAccess(scope.projectId, userId);
      if (!access) return refuse(name, 'not_found', `Project "${scope.projectId}" was not found or you have no access to it. list_projects shows the projects you can read.`);
      const prisma = await db();
      const docs = await prisma.projectDocument.findMany({
        where: { projectId: scope.projectId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, name: true, mimeType: true, sourceUrl: true, status: true, charCount: true, chunkCount: true, createdAt: true, errorMsg: true },
      });
      return j({
        projectId: scope.projectId,
        documents: docs.map((d) => ({
          id: d.id, name: d.name, mimeType: d.mimeType, sourceUrl: d.sourceUrl ?? null, status: d.status,
          charCount: d.charCount, chunkCount: d.chunkCount, createdAt: d.createdAt, ...(d.errorMsg ? { errorMsg: d.errorMsg } : {}),
        })),
        count: docs.length,
        ...(docs.length === 100 ? { truncated: true } : {}),
      });
    }

    // ── MUTATING, NON-CONSEQUENTIAL ─────────────────────────────────────────
    case 'remember_fact': {
      // Live-user-turn requirement (review 2026-09-08 — mirrors forget_fact):
      // a machine-triggered run works on injected web text with 'auto'
      // permissions, and a planted fact rides EVERY future turn of every chat
      // as [USER MEMORY]; forget_fact already refuses machine runs, so without
      // this the asymmetry let machine runs add facts they could never remove.
      // The doctrine's one memory write ('preferences.proactive_offers' off)
      // is a user-turn action anyway.
      if (!ctx.userTurnAt) return refuseNoUserTurn(name, 'Memory is written only from a live user request — a scheduled/automatic run may not remember facts. Put the result in the chat answer (or add_knowledge_note for project material) and let the user decide what to remember.');
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const key = String(args?.key ?? '').trim();
      const value = String(args?.value ?? '').trim();
      if (!key || key.length > MEMORY_KEY_MAX) return refuse(name, 'invalid_key', `key must be 1-${MEMORY_KEY_MAX} characters (got ${key.length}).`);
      if (!value || value.length > MEMORY_VALUE_MAX) return refuse(name, 'invalid_value', `value must be 1-${MEMORY_VALUE_MAX} characters (got ${value.length}) — store the essence, not a transcript.`);
      const contextService = (await import('../context.service')).default;
      const facts = await contextService.getUserMemory(userId);
      const existed = Object.prototype.hasOwnProperty.call(facts, key);
      const count = Object.keys(facts).length;
      if (!existed && count >= MEMORY_FACT_CAP) {
        return refuse(name, 'memory_full', `Memory is full (${count} facts, cap ${MEMORY_FACT_CAP}) — ask the user to prune in Account → Memory before adding new facts (an EXISTING key can still be updated).`);
      }
      // Ticket ccd634fb: the user's explicit remember lifts an older "forget this topic" ban on the
      // same fact (else [BANNED TOPICS] keeps telling every later turn never to mention it).
      const saved = await contextService.updateMemoryFact(userId, key, value, 'tool', { liftRejections: true, ...(ctx.sessionId ? { chatId: ctx.sessionId } : {}) });
      const lifted = Array.isArray(saved?.liftedRejections) ? saved.liftedRejections : [];
      return j({ ok: true, key, totalFacts: existed ? count : count + 1, ...(existed ? { updated: true } : {}), ...(lifted.length ? { liftedBannedTopics: lifted, note: 'The user had earlier asked to forget this topic; their new request to remember it lifted that ban.' } : {}) });
    }

    case 'forget_fact': {
      // Live-user-turn requirement: deleting memory is a user decision. A
      // machine-triggered run (schedule firing, hook wake, dispatched brief —
      // no ctx.userTurnAt, the same anchor the consequential gate keys on)
      // may never forget facts, even at the model's own initiative.
      if (!ctx.userTurnAt) return refuse(name, 'no_user_turn', 'Memory deletion is only allowed from a live user request — a scheduled/automatic run may not forget facts. Tell the user which fact you think is wrong so they can ask you to forget it.');
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const key = String(args?.key ?? '').trim();
      if (!key) return refuse(name, 'invalid_key', 'forget_fact requires the exact key (see list_memory).');
      const contextService = (await import('../context.service')).default;
      const facts = await contextService.getUserMemory(userId);
      if (!Object.prototype.hasOwnProperty.call(facts, key)) {
        const q = key.toLowerCase();
        const suggestions = Object.keys(facts)
          .filter((k) => { const kl = k.toLowerCase(); return kl.includes(q) || q.includes(kl); })
          .slice(0, 5);
        return j({ ok: false, tool: name, reason: 'not_found', key, suggestions, message: suggestions.length ? 'No fact with that exact key — did you mean one of the suggestions? Re-call with the exact key, or ask the user.' : 'No fact with that key exists (list_memory shows the current keys).' });
      }
      await contextService.deleteMemoryFact(userId, key, 'tool');
      return j({ ok: true, key, deleted: true });
    }

    case 'add_knowledge_url':
    case 'add_knowledge_note': {
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const scope = resolveProjectId(ctx, args, name, 'Either create_project + move_chat to file this chat into a project, or ask the user which project to use (list_projects resolves names) and pass projectId.');
      if ('refusal' in scope) return scope.refusal;
      const isUrl = name === 'add_knowledge_url';
      // URL ingestion needs a live user turn (review 2026-09-08): each URL
      // costs three frontier web-search calls + embeddings in
      // ingestion.service and lands in the project's RAG for every chat there
      // (KB poisoning) — not something an unattended run on injected text may
      // trigger. Notes (text the run already holds) stay allowed under the caps.
      if (isUrl && !ctx.userTurnAt) return refuseNoUserTurn(name, 'URL ingestion is only allowed from a live user request — a scheduled/automatic run may not add web pages to a knowledge base. Save text you already have with add_knowledge_note, or put the sources in the chat answer for the user to save.');
      // Self-host setup hardening (2026-10-20): a URL cannot be fetched on an
      // instance with no search / page-reading backend — refuse before a doomed
      // row promises "fetched, chunked and embedded in the background".
      if (isUrl && webSearchMissingOnInstance()) return refuse(name, 'web_search_not_configured', 'URL ingestion needs web page fetching, which is not set up on this Digby instance. An admin enables web search under Account → Admin → Setup → Web search (BRIGHTDATA_API_TOKEN, or the MCP gateway profile with MCP_DIGBY_URL + MCP_DIGBY_TOKEN). Text you already have can be saved with add_knowledge_note.');
      // Validate the payload BEFORE the access read (cheap first).
      let url = '';
      let displayName = '';
      let text = '';
      if (isUrl) {
        url = String(args?.url ?? '').trim();
        let parsed: URL | null = null;
        try { parsed = new URL(url); } catch { parsed = null; }
        if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
          return refuse(name, 'invalid_url', 'url must be a valid http:// or https:// address.');
        }
        const given = typeof args?.name === 'string' ? args.name.trim() : '';
        // Default name = host + path, exactly like documents.controller addUrlToProject.
        displayName = (given || (parsed.hostname + (parsed.pathname !== '/' ? parsed.pathname : ''))).slice(0, KNOWLEDGE_NAME_MAX);
      } else {
        displayName = String(args?.name ?? '').trim();
        if (!displayName || displayName.length > KNOWLEDGE_NAME_MAX) return refuse(name, 'invalid_name', `name must be 1-${KNOWLEDGE_NAME_MAX} characters (got ${displayName.length}).`);
        text = String(args?.text ?? '');
        if (text.trim().length < KNOWLEDGE_NOTE_MIN || text.length > KNOWLEDGE_NOTE_MAX) {
          return refuse(name, 'invalid_text', `text must be ${KNOWLEDGE_NOTE_MIN}-${KNOWLEDGE_NOTE_MAX} characters (got ${text.length}) — a knowledge document needs real content.`);
        }
      }
      const access = await platform.getProjectAccess(scope.projectId, userId);
      if (!access) return refuse(name, 'not_found', `Project "${scope.projectId}" was not found or you have no access to it (list_projects).`);
      if (!EDITOR_ROLES.has(access.role)) return refuse(name, 'forbidden', `You are a viewer on project "${access.project?.name ?? scope.projectId}" — only owners/editors/admins can add knowledge. Ask the project owner, or save the fact to your own memory (remember_fact) instead.`);
      const prisma = await db();
      const docCount = await prisma.projectDocument.count({ where: { projectId: scope.projectId } });
      if (docCount >= KNOWLEDGE_DOCS_PER_PROJECT_CAP) {
        return refuse(name, 'project_full', `Project "${access.project?.name ?? scope.projectId}" already has ${docCount} documents (cap ${KNOWLEDGE_DOCS_PER_PROJECT_CAP}). Ask the user to remove stale documents in the project's Files view first.`);
      }
      // Rate caps (review 2026-09-08) — shared by url + note, checked AFTER the
      // cheap validation/access refusals so a doomed call never burns a slot.
      // On a redis error we LOG and ALLOW like notify_user: a down cache must
      // not block the user's own explicit request (the user-turn requirement
      // above already bounds the URL path to live turns).
      const { dayKey, hourKey } = rateKeys('knowledge', userId, ctx.sessionId);
      try {
        const redis = (await import('../../../config/redis')).default;
        const gate = await consumeRateSlots(redis, [
          { key: hourKey, cap: KNOWLEDGE_CHAT_HOURLY_CAP, ttlSec: HOUR_KEY_TTL, scope: 'chat_hourly' },
          { key: dayKey, cap: KNOWLEDGE_USER_DAILY_CAP, ttlSec: DAY_KEY_TTL, scope: 'user_daily' },
        ]);
        if (!gate.ok) {
          return gate.scope === 'chat_hourly'
            ? refuse(name, 'rate_limited', `This chat has already added ${KNOWLEDGE_CHAT_HOURLY_CAP} knowledge documents this hour (cap ${KNOWLEDGE_CHAT_HOURLY_CAP}/hour per chat). List the remaining sources in the chat answer for the user to save later; do not retry this run.`, { scope: 'chat_hourly' })
            : refuse(name, 'rate_limited', `The user has already added ${KNOWLEDGE_USER_DAILY_CAP} knowledge documents today (cap ${KNOWLEDGE_USER_DAILY_CAP}/day). List the remaining sources in the chat answer instead; do not retry this run.`, { scope: 'user_daily' });
        }
      } catch (err: any) {
        void logAccountTools('warn', `account-tools: ${name} rate-cap check failed (allowing — user-scoped): ${err?.message ?? err}`);
      }
      const doc = await prisma.projectDocument.create({
        data: {
          projectId: scope.projectId,
          userId,
          name: displayName,
          mimeType: isUrl ? 'url' : 'pasted',
          ...(isUrl ? { sourceUrl: url } : { charCount: text.length }),
          status: 'processing',
          source: 'knowledge',
        },
      });
      // Fire-and-forget ingestion (fetch/chunk/embed) — the same background
      // shape documents.controller uses; a failure is logged on the doc row by
      // the pipeline and surfaces as status 'error' in list_knowledge_documents.
      import('../ingestion.service')
        .then((m) => (isUrl ? m.processDocument(doc.id) : m.processDocument(doc.id, text)))
        .catch((err: any) => { void logAccountTools('warn', `account-tools: background ingestion failed for doc ${doc.id}: ${err?.message ?? err}`); });
      return j({
        ok: true, tool: name, documentId: doc.id, projectId: scope.projectId, name: doc.name, mimeType: doc.mimeType,
        ...(isUrl ? { sourceUrl: url } : { charCount: text.length }),
        status: 'processing',
        note: 'ingestion runs in the background; list_knowledge_documents shows the status (ready|error) — tell the user it will ground future chats in this project once ready.',
      });
    }

    case 'update_canvas': {
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const canvasId = String(args?.canvasId ?? '').trim();
      if (!canvasId) return refuse(name, 'invalid_args', 'update_canvas requires canvasId (from list_canvases).');
      const hasContent = typeof args?.content === 'string';
      const hasTitle = typeof args?.title === 'string' && args.title.trim().length > 0;
      if (!hasContent && !hasTitle) return refuse(name, 'invalid_args', 'update_canvas needs content and/or title.');
      if (hasContent && args.content.length > CANVAS_CONTENT_MAX) return refuse(name, 'too_large', `content must be ≤ ${CANVAS_CONTENT_MAX} characters (got ${args.content.length}).`);
      const prisma = await db();
      const existing = await prisma.canvasDocument.findFirst({ where: { id: canvasId, userId }, select: { id: true } });
      if (!existing) return refuse(name, 'not_found', `No canvas "${canvasId}" is owned by you. Copy the exact id from list_canvases.`);
      const updated = await prisma.canvasDocument.update({
        where: { id: canvasId },
        data: {
          ...(hasContent ? { content: args.content } : {}),
          ...(hasTitle ? { title: String(args.title).trim().slice(0, 200) } : {}),
          version: { increment: 1 },
        },
        select: { id: true, version: true, title: true },
      });
      // No 'canvas' SSE emit: the chat stream adapter (chat-agent/sse-adapter.ts
      // handle()) drops tool-emitted 'canvas' events, so an emit here would be
      // dead — the panel re-reads the row when the user reopens the canvas.
      return j({ ok: true, canvasId: updated.id, version: updated.version, title: updated.title, note: 'saved — the canvas panel shows the new version when the user reopens it' });
    }

    case 'revoke_share_link': {
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const chatId = targetChatId(ctx, args);
      const sharing = await import('../sharing.service');
      const r = await sharing.revokeChatShareLink({ chatId, userId });
      if (!r.ok) {
        if (r.reason === 'no_link') return j({ ok: true, chatId, revoked: false, note: 'this chat never had a share link — nothing to revoke' });
        return refuse(name, 'not_found', `Chat "${chatId}" was not found among the chats you own (only the owner can revoke a share link). Copy the exact id from list_chats, or omit chatId for THIS chat.`);
      }
      return j({ ok: true, chatId, revoked: true, note: 'the public page now returns 410; create_share_link re-activates the same link later' });
    }

    case 'notify_user': {
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const message = String(args?.message ?? '').trim();
      if (!message || message.length > NOTIFY_MESSAGE_MAX) return refuse(name, 'invalid_message', `message must be 1-${NOTIFY_MESSAGE_MAX} characters (got ${message.length}).`);
      const channel = args?.channel === 'telegram' ? 'telegram' : 'auto';
      const tg = await import('../telegram/telegram.service');
      if (!tg.isConfigured()) {
        return refuse(name, 'not_configured', 'This Digby instance has no Telegram bot configured, so there is no channel to notify through. Say so in the chat answer instead.', { channel });
      }
      const prisma = await db();
      const link = await (prisma as any).telegramLink.findUnique({ where: { userId }, select: { chatId: true, username: true } });
      if (!link) {
        return j({
          ok: false, tool: name, reason: 'telegram_not_linked',
          guidance: 'The user has no linked Telegram. Call telegram_connect_link (read-only — it returns the in-app connect page to show them) or point them to Account → Integrations → Telegram. Do NOT claim a notification was sent.',
        });
      }
      // audit 2026-10-06 T3-6 (platform/notify-guard.ts): no near-duplicate
      // push inside the window, no push that cites / re-raises a question the
      // owner DISMISSED. Ticket abca56ce adds the KPI leg: no re-announcement
      // of a KPI whose of-record state (value + met/unmet) is unchanged.
      // Before the rate caps, so a refusal spends no slot.
      const guard = await import('./notify-guard');
      const dup = await guard.findNotifyDuplicate(userId, message);
      const dismissed = dup ? null : await guard.findDismissedQuestionRaised(userId, message);
      const kpiRepeat = dup || dismissed ? null : await guard.findKpiReannouncement(userId, message);
      if (dup || dismissed || kpiRepeat) {
        try {
          const { recordLoopMetric } = await import('./loop-metrics.service');
          recordLoopMetric({ kind: 'notify_user_refused', sessionId: ctx.sessionId, meta: dup ? { reason: 'duplicate', similarity: dup.similarity, priorAt: dup.priorAt } : dismissed ? { reason: 'dismissed_question', oqId: dismissed.id, via: dismissed.via } : { reason: 'kpi_reannouncement', key: kpiRepeat!.key, priorValue: kpiRepeat!.priorValue, value: kpiRepeat!.value, met: kpiRepeat!.met } });
        } catch { /* telemetry is best-effort */ }
        return dup
          ? refuse(name, 'duplicate_notification', guard.renderNotifyDuplicateRefusal(dup), { priorAt: dup.priorAt, similarity: dup.similarity })
          : dismissed
            ? refuse(name, 'dismissed_question', guard.renderNotifyDismissedRefusal(dismissed), { questionId: dismissed.id })
            : refuse(name, 'kpi_reannouncement', guard.renderKpiReannounceRefusal(kpiRepeat!), { kpiKey: kpiRepeat!.key, priorValue: kpiRepeat!.priorValue, value: kpiRepeat!.value });
      }
      // Rate caps — self-channel, bounded blast radius: on a redis error we
      // LOG and ALLOW (a down cache must not silence the user's own alerts).
      // consumeRateSlots gives the hourly slot back on a daily refusal so the
      // refusal reason is always the cap that actually applies (review 2026-09-08).
      const { dayKey, hourKey } = rateKeys('notify', userId, ctx.sessionId);
      try {
        const redis = (await import('../../../config/redis')).default;
        const gate = await consumeRateSlots(redis, [
          { key: hourKey, cap: NOTIFY_CHAT_HOURLY_CAP, ttlSec: HOUR_KEY_TTL, scope: 'chat_hourly' },
          { key: dayKey, cap: NOTIFY_USER_DAILY_CAP, ttlSec: DAY_KEY_TTL, scope: 'user_daily' },
        ]);
        if (!gate.ok) {
          return gate.scope === 'chat_hourly'
            ? refuse(name, 'rate_limited', `This chat has already sent ${NOTIFY_CHAT_HOURLY_CAP} notifications this hour (cap ${NOTIFY_CHAT_HOURLY_CAP}/hour per chat). Batch further updates into the chat answer instead; do not retry this run.`, { scope: 'chat_hourly' })
            : refuse(name, 'rate_limited', `The user has already received ${NOTIFY_USER_DAILY_CAP} notifications today (cap ${NOTIFY_USER_DAILY_CAP}/day). Put the update in the chat answer instead; do not retry this run.`, { scope: 'user_daily' });
        }
      } catch (err: any) {
        void logAccountTools('warn', `account-tools: notify_user rate-cap check failed (allowing — self-channel): ${err?.message ?? err}`);
      }
      // Footer names the originating chat so a notification is traceable.
      let title: string | null = null;
      try {
        const chat = await prisma.crossModelChat.findUnique({ where: { id: ctx.sessionId }, select: { title: true } });
        title = chat?.title ?? null;
      } catch { title = null; }
      const footer = title ? `— Digby (from chat: "${title.replace(/\s+/g, ' ').slice(0, 80)}")` : '— Digby';
      // audit 2026-10-06 T2-2: the push is credential-scrubbed on every turn and
      // the result says so (OUTBOUND_SECRET_REDACT_DISABLED=1 sends verbatim).
      const outbound = scrubOutboundField({ message }, 'message');
      const text = `${outbound ? outbound.args.message : message}\n\n${footer}`;
      const sent = await tg.sendMessage(link.chatId, text);
      if (!sent) return refuse(name, 'send_failed', 'Telegram did not accept the message (bot error or the user blocked the bot). Nothing was delivered — put the update in the chat answer and tell the user the push failed.', { channel: 'telegram' });
      // T3-6: the dedupe window remembers delivered pushes only (the scrubbed
      // text — T2-2 — so no credential feeds the dedupe memory).
      await guard.rememberNotify(userId, outbound ? outbound.args.message : message);
      // Ticket abca56ce: remember the of-record state of every KPI this push
      // announced, so a later push with a different number but the SAME
      // register state is refused as a re-announcement.
      await guard.rememberKpiAnnouncements(userId, outbound ? outbound.args.message : message);
      const okEnvelope = j({ ok: true, tool: name, channel: 'telegram', deliveredTo: link.username ? `@${link.username}` : 'your Telegram', chars: text.length });
      if (!outbound) return okEnvelope;
      recordOutboundRedaction(ctx, name, ctx.sessionId, outbound.scrub);
      return appendOutboundRedactionNote(okEnvelope, outbound.scrub);
    }

    case 'send_email_as_digby': {
      // Email AS Digby (ticket 54f237bf) — the machine-capable outbound email
      // channel. NOT gated on a user turn (a scheduled digest firing must be
      // able to send one — that is the whole point) and NOT consequential: it
      // is rate-capped per instance and telemetry'd, exactly the blast-radius
      // argument that keeps notify_user non-consequential. The email service
      // (email/digby-email.service) is loaded DYNAMICALLY — it statically
      // imports loop-metrics → config/database, which must stay out of this
      // module's static graph (see the header's import discipline).
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const email = await import('../email/digby-email.service');
      const to = typeof args?.to === 'string' ? args.to.trim() : '';
      const cc = typeof args?.cc === 'string' ? args.cc.trim() : '';
      const subject = typeof args?.subject === 'string' ? args.subject.trim() : '';
      const text = typeof args?.text === 'string' ? args.text : '';
      // Cheap bounds first (mirrors the service's own validation) so the tool
      // refusal is actionable BEFORE any transport work.
      if (!to || !email.isValidEmailAddress(to)) {
        return refuse(name, 'invalid_recipient', `"to" must be exactly one valid email address (got ${JSON.stringify(String(args?.to ?? '').slice(0, 60))}). Ask the user for the exact address; do not retry this run.`);
      }
      if (cc && !email.isValidEmailAddress(cc)) {
        return refuse(name, 'invalid_recipient', `"cc" must be exactly one valid email address or omitted (got ${JSON.stringify(cc.slice(0, 60))}).`);
      }
      if (!subject) return refuse(name, 'invalid_subject', `subject must be 1-${DIGBY_EMAIL_SUBJECT_MAX} characters (got 0).`);
      if (subject.length > DIGBY_EMAIL_SUBJECT_MAX) {
        return refuse(name, 'invalid_subject', `subject must be 1-${DIGBY_EMAIL_SUBJECT_MAX} characters (got ${subject.length}).`);
      }
      if (!text.trim()) return refuse(name, 'invalid_body', `text body must be 1-${DIGBY_EMAIL_TEXT_MAX} characters (got 0).`);
      if (text.length > DIGBY_EMAIL_TEXT_MAX) {
        return refuse(name, 'invalid_body', `text body must be 1-${DIGBY_EMAIL_TEXT_MAX} characters (got ${text.length}).`);
      }
      const r = await email.sendDigbyEmail({ to, subject, text, ...(cc ? { cc } : {}) }, { sessionId: ctx.sessionId });
      if (!r.ok) {
        // not_configured / rate_limited / transport failure — each already
        // carries the actionable guidance the model needs to relay honestly.
        const reason = r.error.startsWith('Digby email is not configured') ? 'not_configured'
          : r.error.startsWith('rate limit') ? 'rate_limited'
          : r.error.startsWith('invalid') ? 'invalid_args'
          : 'send_failed';
        return refuse(name, reason, `${r.error} Nothing was sent — do not claim an email went out.`);
      }
      return j({ ok: true, tool: name, to, from: r.from, messageId: r.messageId, note: 'delivered to the SMTP relay' });
    }

    case 'set_chat_instructions': {
      // Live-user-turn requirement (review 2026-09-08): the per-chat
      // systemPrompt is appended with HIGHEST precedence to every future turn
      // (chat-context.ts, after the project chain) and no UI surfaces or
      // clears it — an invisible persistent prompt-injection primitive if a
      // machine run on injected text could write it.
      // T3b (2026-09-24): a FOREIGN target (chatId = another chat the user
      // owns) arrives here only after the consequential gate — card, autonomy
      // grant, parent-implicit or supervisor seat. The SELF target keeps the
      // live-user-turn rule byte-identically.
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const explicitChat = typeof args?.chatId === 'string' ? args.chatId.trim() : '';
      const chatId = explicitChat && explicitChat !== ctx.sessionId ? explicitChat : ctx.sessionId;
      const foreign = chatId !== ctx.sessionId;
      if (!foreign && !ctx.userTurnAt) return refuseNoUserTurn(name, 'Standing instructions on THIS chat are set only from a live user request — a scheduled/automatic run may not change how its own chat answers. Put your suggestion in the chat answer and let the user ask for it.');
      if (typeof args?.instructions !== 'string') return refuse(name, 'invalid_args', "set_chat_instructions requires instructions (a string; '' clears them).");
      const instructions = args.instructions.trim();
      if (instructions.length > CHAT_INSTRUCTIONS_MAX) return refuse(name, 'too_large', `instructions must be ≤ ${CHAT_INSTRUCTIONS_MAX} characters (got ${instructions.length}).`);
      const prisma = await db();
      // ONE conditional write: owner + not-a-supervisor enforced in the WHERE —
      // count 0 covers not-found, not-owner and supervisor alike (no existence
      // leak); a supervisor's prompt is platform-owned and never user-editable.
      // BOTH supervisor classes (hardening 2026-09-14): isSupervisor is the
      // FLEET lane only (schema: never reused), so a project supervisor row
      // (isProjectSupervisor) was unguarded — an owner typing "clear your
      // standing instructions" in '<project> Supervisor' NULLed the lane's sole
      // doctrine carrier and the stale-prompt heal bails on a null prompt.
      const r = await prisma.crossModelChat.updateMany({
        where: { id: chatId, userId, isSupervisor: false, isProjectSupervisor: false },
        data: { systemPrompt: instructions ? instructions : null },
      });
      if (r.count === 0) {
        return refuse(name, 'not_found_or_refused', `This chat (${chatId}) does not accept instructions (not a chat you own, or a Fleet Supervisor / Project Supervisor chat — whose prompt is platform-managed).`);
      }
      // Audit trail (Activity, resource 'platform') — the ONLY durable record
      // outside the run transcript of a change the user cannot otherwise see.
      await auditAccountAction(userId, instructions ? 'chat.instructions.set' : 'chat.instructions.clear', {
        tool: name, chatId, chars: instructions.length, preview: instructions.replace(/\s+/g, ' ').slice(0, 200),
        ...(foreign ? { fromChatId: ctx.sessionId, machine: !ctx.userTurnAt } : {}),
      });
      return j({ ok: true, chatId, cleared: !instructions, chars: instructions.length, note: instructions ? 'applies from the NEXT turn of this chat onward; visible in get_account_overview → thisChat.instructions' : 'standing instructions removed' });
    }

    // ── MUTATING + CONSEQUENTIAL (post-gate — args are the STAGED args) ─────
    case 'create_share_link': {
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const chatId = targetChatId(ctx, args);
      const exp = args?.expiresInDays;
      if (exp !== undefined && exp !== null && !SHARE_EXPIRY_CHOICES.includes(Number(exp) as 7 | 30)) return refuse(name, 'invalid_expiry', 'expiresInDays must be 7 or 30, or omitted for a link that never expires.');
      const expiresInDays = exp === undefined || exp === null ? undefined : Number(exp);
      const sharing = await import('../sharing.service');
      const r = await sharing.createOrReactivateChatShareLink({ chatId, userId, expiresInDays });
      if (!r.ok) {
        if (r.reason === 'coding_chat') return refuse(name, 'coding_chat', 'Coding chats cannot be shared publicly (their transcripts live in the coding session and may contain tool output from the owner\'s environment).');
        return refuse(name, 'not_found', `Chat "${chatId}" was not found among the chats you own — only the owner can share a chat. Copy the exact id from list_chats, or omit chatId for THIS chat.`);
      }
      return j({
        ok: true, tool: name, ids: { chatId, shareToken: r.shareToken },
        chatId, shareUrl: r.shareUrl, expiresAt: r.expiresAt, reactivated: r.reactivated,
        message: `Public read-only share link for chat ${chatId}: ${r.shareUrl} (expires ${r.expiresAt ? r.expiresAt.toISOString() : 'never'}). Show it to the user as a markdown link; revoke_share_link turns it off.`,
      });
    }

    case 'telegram_connect_link': {
      // READ-ONLY (2026-09-08 review): no token is minted here — see the module
      // header. Nothing to gate; it may run in any run type, anonymous excepted.
      if (isAnonymous(ctx)) return refuseAnonymous(name);
      const tg = await import('../telegram/telegram.service');
      if (!(tg.isConfigured() && tg.getBotUsername())) return refuse(name, 'not_configured', 'This Digby instance has no Telegram bot configured, so Telegram cannot be connected here.');
      const prisma = await db();
      const link = await (prisma as any).telegramLink.findUnique({ where: { userId }, select: { username: true } });
      if (link) return refuse(name, 'already_linked', 'This account is already linked to Telegram — use notify_user to message the user there.', { username: link.username ?? null, guidance: 'use notify_user' });
      // NO token here (review 2026-09-08 — see the module header): the connect
      // URL is a bearer credential that binds whoever opens it to this account.
      // It is minted only in the user's own browser (IntegrationsTab → POST
      // /telegram/connect-link); this result carries the non-secret page.
      const connectPage = accountIntegrationsUrl();
      return j({
        ok: true, tool: name, ids: { userId },
        action: 'open_integrations', connectPage, botUsername: tg.getBotUsername(),
        instructions: 'Show connectPage to the user as a markdown link. There they press "Connect Telegram" — their browser mints a one-time link (valid 10 minutes) — then tap it and press Start in Telegram; the account links within seconds, and from then on notify_user works and they can chat with you from Telegram. You never see or relay the connect link itself.',
        message: `Telegram connect: send the user to Account → Integrations → Connect Telegram (${connectPage}); the one-time link is minted in their browser.`,
      });
    }

    default:
      return `Unknown account tool: ${name}`;
  }
}
