/**
 * digby-mcp — tool registrations.
 *
 * The 17 tools mirror the P1 internal platform tool set
 * (backend/src/modules/crossmodel/platform/platform-tools.ts) 1:1 onto the
 * platform REST endpoints (docs/DIGBY_PLATFORM_API.md). Input schemas mirror
 * the REST bodies (platform.validation.ts).
 *
 * The caller's token (`authorization`, "Bearer <jwt-or-dgt_…>") is captured at
 * connection time and forwarded verbatim on every call — the server is a dumb
 * pipe: identity, scopes, and owner/member scoping are enforced by the backend.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as platform from './platform.js';

// Mirrors PATIENCE_MODES + the 'auto' router detent (platform.validation.ts).
const CHAT_MODES = [
  'single_thinking',
  'thinking',
  'deep_research',
  'auto',
  // legacy aliases accepted + normalized by the API
  'single',
  'fast',
  'deep_research_all',
  'browser_agent',
] as const;

const chatMode = z
  .enum(CHAT_MODES)
  .optional()
  .describe(
    "Patience pipeline: 'single_thinking' (quick), 'thinking' (ensemble — the default), " +
    "'deep_research' (deep research), or 'auto' (the platform's router picks a level). " +
    "Legacy aliases ('single', 'fast', 'deep_research_all') are accepted and normalized by the API.",
  );

const permissionMode = z
  .enum(['auto', 'plan', 'ask'])
  .optional()
  .describe("Tool gating for the session's runs (default: the user's saved preference).");

// zod v4 bump (GHSA-mrhx-c7xc-m3w5): `.uuid()` tightened to RFC 9562 and would
// newly reject variant-invalid hex that v3 accepted — keep the exact v3 shape
// check (case-insensitive 8-4-4-4-12 hex) so a dependency bump never tightens
// this tool's id gate. Mirrors backend/src/utils/zod-uuid.ts (PR #1973).
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (label: string) =>
  z.string().regex(UUID_SHAPE, `Invalid ${label} ID`);

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Compact text rendering: a one-line summary followed by the REST JSON. */
function ok(summary: string, data?: unknown): ToolResult {
  const text = data === undefined ? summary : `${summary}\n\n${JSON.stringify(data, null, 1)}`;
  return { content: [{ type: 'text' as const, text }] };
}

/** Failure surface: the clear, actionable message from the API layer, flagged as an MCP error. */
function fail(err: any): ToolResult {
  return { content: [{ type: 'text' as const, text: err?.message || String(err) }], isError: true };
}

/** Wrap a handler so rejections become isError tool results instead of transport errors. */
const guard = <A>(fn: (args: A) => Promise<ToolResult>) => {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err: any) {
      return fail(err);
    }
  };
};

/**
 * Register all platform tools on `server`. `authorization` is the caller's
 * per-user credential ("Bearer <token>") forwarded verbatim to the API.
 */
export function registerDigbyTools(server: McpServer, authorization: string): void {
  // ── Chats ─────────────────────────────────────────────────────────────────

  server.tool(
    'list_chats',
    "List the user's chats (own + shared-folder chats), most recently updated first. Scope: chats:read.",
    {
      folderId: uuid('folder').optional().describe('Only chats in this folder.'),
      mode: z.enum(CHAT_MODES).optional().describe('Only chats with this patience mode.'),
      status: z
        .enum(['provisioning', 'ready', 'running', 'error', 'archived'])
        .optional()
        .describe('Only chats whose coding state has this status.'),
      page: z.number().int().positive().optional().describe('Page number (default 1).'),
      limit: z.number().int().positive().max(50).optional().describe('Page size (default 50).'),
    },
    guard(async ({ folderId, mode, status, page, limit }) => {
      const data = await platform.listChats(authorization, { folderId, mode, status, page, limit });
      const count = Array.isArray(data?.chats) ? data.chats.length : 0;
      return ok(`${count} chat(s).`, data);
    }),
  );

  server.tool(
    'get_chat_status',
    'Get the live status of one chat: whether a run is active, coding state (status/branch/permissionMode/model) if it is a coding session, and plan progress. Scope: chats:read.',
    {
      chatId: uuid('chat'),
    },
    guard(async ({ chatId }) => {
      const data = await platform.getChatStatus(authorization, chatId);
      return ok(`Status of chat ${chatId}.`, data);
    }),
  );

  server.tool(
    'create_chat',
    'Create a new chat, optionally inside a folder. Scope: chats:write.',
    {
      title: z.string().min(1).max(200).describe('Chat title.'),
      folderId: uuid('folder').nullish().describe('Optional folder to file the chat in (null = ungrouped).'),
      mode: chatMode,
    },
    guard(async ({ title, folderId, mode }) => {
      const chat = await platform.createChat(authorization, { title, folderId, mode });
      return ok(`Created chat ${chat.id} "${chat.title}".`, chat);
    }),
  );

  server.tool(
    'send_chat_message',
    "Send a message to a chat: the user's message is queued and a detached agent turn starts answering it in the background — exactly as if the user sent it in the UI. Fails if a run is already active in that chat. Scope: chats:write.",
    {
      chatId: uuid('chat'),
      content: z.string().min(1).max(100_000).describe('The message text.'),
      mode: chatMode.describe(
        "Per-message patience override (default: the chat's stored mode). 'auto' routes via the platform's heuristic router and reports the choice.",
      ),
    },
    guard(async ({ chatId, content, mode }) => {
      const data = await platform.sendChatMessage(authorization, chatId, { content, mode });
      return ok(`Message queued in chat ${chatId} — a detached run is answering it now. Poll get_chat_status for progress.`, data);
    }),
  );

  server.tool(
    'start_coding_session',
    "Start a coding session from a chat (the chat must be in a folder with a repository workspace). Returns the session — it provisions in the background; poll get_chat_status until coding.status is 'ready'. Scope: code:run.",
    {
      chatId: uuid('chat').describe('The chat to turn into a coding session.'),
      permissionMode,
    },
    guard(async ({ chatId, permissionMode }) => {
      const s = await platform.startCodingSession(authorization, chatId, { permissionMode });
      return ok(
        `Started coding session ${s.id} "${s.title}"${s.branch ? ` on branch ${s.branch}` : ''}. It is provisioning now — poll get_chat_status(chatId:"${s.id}") until coding.status is "ready".`,
        s,
      );
    }),
  );

  server.tool(
    'move_chat',
    'Move a chat into a folder (or ungroup it with folderId null). Owner-only; coding chats cannot move (their worktree is folder-keyed). Scope: chats:write.',
    {
      chatId: uuid('chat'),
      folderId: uuid('folder').nullable().describe('Target folder id, or null to ungroup.'),
    },
    guard(async ({ chatId, folderId }) => {
      const chat = await platform.patchChat(authorization, chatId, { folderId });
      return ok(
        chat.projectId
          ? `Moved chat ${chatId} into folder ${chat.projectId}.`
          : `Removed chat ${chatId} from its folder (now ungrouped).`,
        chat,
      );
    }),
  );

  server.tool(
    'rename_chat',
    'Rename a chat (owner or folder editor/admin). Scope: chats:write.',
    {
      chatId: uuid('chat'),
      title: z.string().min(1).max(200).describe('New title.'),
    },
    guard(async ({ chatId, title }) => {
      const chat = await platform.patchChat(authorization, chatId, { title });
      return ok(`Renamed chat ${chatId} to "${title}".`, chat);
    }),
  );

  server.tool(
    'archive_chat',
    'Archive (or unarchive with archived=false) a coding chat. Owner-only; refuses while a run is active; plain chats cannot be archived (the API returns 400). Scope: chats:write.',
    {
      chatId: uuid('chat'),
      archived: z.boolean().optional().describe('Default true. Pass false to unarchive.'),
    },
    guard(async ({ chatId, archived }) => {
      const chat = await platform.patchChat(authorization, chatId, { archived: archived ?? true });
      return ok(archived === false ? `Unarchived chat ${chatId}.` : `Archived chat ${chatId}.`, chat);
    }),
  );

  server.tool(
    'delete_chat',
    'PERMANENTLY delete a chat and its transcript. Owner-only. DESTRUCTIVE — confirm with the user first. Scope: chats:write.',
    {
      chatId: uuid('chat'),
    },
    guard(async ({ chatId }) => {
      const data = await platform.deleteChat(authorization, chatId);
      return ok(`Deleted chat ${chatId}.`, data);
    }),
  );

  // ── Folders ───────────────────────────────────────────────────────────────

  server.tool(
    'list_folders',
    'List the folder tree: owned + shared folders as flat lists with parentId/depth/path (assemble the tree client-side). Scope: folders:read.',
    {},
    guard(async () => {
      const data = await platform.listFolders(authorization);
      return ok('Folder tree (flat lists — parentId/depth/path; assemble client-side).', data);
    }),
  );

  server.tool(
    'create_folder',
    'Create a folder for chats (optional shared system prompt, emoji, color). Pass parentId to nest (max depth 5). The caller becomes its owner. Scope: folders:write.',
    {
      name: z.string().min(1).max(200).describe('Folder name.'),
      parentId: uuid('parent folder').nullish().describe('Optional parent folder id — nests this folder inside it.'),
      emoji: z.string().max(8).optional().describe("Default '📁'."),
      color: z.string().max(32).optional().describe('violet | blue | green | amber | rose. Default violet.'),
      systemPrompt: z.string().max(20000).nullish().describe('Custom instructions prepended to all chats in this folder.'),
      description: z.string().max(5000).nullish().describe('Optional description.'),
    },
    guard(async ({ name, parentId, emoji, color, systemPrompt, description }) => {
      const folder = await platform.createFolder(authorization, { name, parentId, emoji, color, systemPrompt, description });
      return ok(`Created folder ${folder.id} "${folder.name}"${folder.parentId ? ` (nested in ${folder.parentId}, depth ${folder.depth})` : ''}.`, folder);
    }),
  );

  server.tool(
    'update_folder',
    'Update a folder (name/emoji/color/systemPrompt/description). Owner or editor/admin member. To MOVE a folder use move_folder. Scope: folders:write.',
    {
      folderId: uuid('folder'),
      name: z.string().min(1).max(200).optional(),
      emoji: z.string().max(8).optional(),
      color: z.string().max(32).optional(),
      systemPrompt: z.string().max(20000).nullish(),
      description: z.string().max(5000).nullish(),
    },
    guard(async ({ folderId, name, emoji, color, systemPrompt, description }) => {
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (emoji !== undefined) body.emoji = emoji;
      if (color !== undefined) body.color = color;
      if (systemPrompt !== undefined) body.systemPrompt = systemPrompt;
      if (description !== undefined) body.description = description;
      const folder = await platform.patchFolder(authorization, folderId, body);
      return ok(`Updated folder ${folderId}.`, folder);
    }),
  );

  server.tool(
    'move_folder',
    'Move a folder — with its whole subtree — under another folder, or to the root with parentId null. Owner-only. Cycle-checked and depth-capped (max depth 5). Scope: folders:write.',
    {
      folderId: uuid('folder'),
      parentId: uuid('parent folder').nullable().describe('Target parent folder id, or null to make it a root folder.'),
    },
    guard(async ({ folderId, parentId }) => {
      const folder = await platform.patchFolder(authorization, folderId, { parentId });
      return ok(
        parentId ? `Moved folder ${folderId} under ${parentId}.` : `Moved folder ${folderId} to the root.`,
        folder,
      );
    }),
  );

  server.tool(
    'delete_folder',
    'PERMANENTLY delete a folder. Its coding chats are deleted with it; plain chats are ungrouped (kept). Child folders promote to root unless reparentTo is given. Owner-only. DESTRUCTIVE — confirm with the user first. Scope: folders:write.',
    {
      folderId: uuid('folder'),
      reparentTo: uuid('reparent folder').optional().describe('Move child folders under this folder instead of promoting them to root.'),
    },
    guard(async ({ folderId, reparentTo }) => {
      const data = await platform.deleteFolder(authorization, folderId, reparentTo);
      return ok(`Deleted folder ${folderId}.`, data);
    }),
  );

  // ── Schedules ─────────────────────────────────────────────────────────────

  server.tool(
    'create_schedule',
    "Schedule a prompt to run against a chat on an interval: coding chats fire a full coding run; plain chats fire a detached chat-agent turn. kind 'once' = a single run after intervalSec; 'recurring' = every intervalSec. Scope: schedules:write.",
    {
      chatId: uuid('chat').describe('Target chat (owner-only).'),
      prompt: z.string().min(1).max(100_000).describe('The instruction each firing runs (write it standalone).'),
      kind: z.enum(['once', 'recurring']).describe("'once' = a single run; 'recurring' = every intervalSec."),
      intervalSec: z.number().int().positive().describe('Delay (once) or cadence (recurring), in seconds.'),
    },
    guard(async ({ chatId, prompt, kind, intervalSec }) => {
      const s = await platform.createSchedule(authorization, { chatId, prompt, kind, intervalSec });
      return ok(`Created schedule ${s.id ?? ''} for chat ${chatId} (${kind}, every ${intervalSec}s). Keep its id for cancel_schedule.`, s);
    }),
  );

  server.tool(
    'list_schedules',
    "List ALL of the user's schedules across every chat (active and finished): target chat, next run time, cadence, run counts, last status. Scope: schedules:write (list is privileged — a schedule fires with the owner's identity).",
    {},
    guard(async () => {
      const data = await platform.listSchedules(authorization);
      const count = Array.isArray(data?.schedules) ? data.schedules.length : 0;
      return ok(`${count} schedule(s).`, data);
    }),
  );

  server.tool(
    'cancel_schedule',
    "Cancel (disable) any of the user's schedules by id (from create_schedule / list_schedules). Scope: schedules:write.",
    {
      scheduleId: uuid('schedule'),
    },
    guard(async ({ scheduleId }) => {
      const data = await platform.cancelSchedule(authorization, scheduleId);
      return ok(`Cancelled schedule ${scheduleId}.`, data);
    }),
  );
}
