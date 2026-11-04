/**
 * Account housekeeping tools — agent capability gap audit, tranche 4a
 * (P2 #21–#25; 2026-09-24): knowledge-base housekeeping, canvas lifecycle,
 * project archive, account preferences. (The feeds lifecycle tools
 * set_feed / refresh_feed / delete_feed were retired with the topic-feeds
 * subsystem, ticket 43c24152, 2026-10-20 — a topic digest is a schedule on
 * a real chat now.)
 *
 *   remove_knowledge_document {documentId}                                 ASK-ONLY (destructive: chunks cascade)
 *   add_knowledge_file        {fileId|uploadId, projectId?, name?}         MUTATING, non-consequential (editor+; knowledge caps)
 *   create_canvas             {title, type?, language?, content, chatId?}  MUTATING, non-consequential (owner of the chat)
 *   delete_canvas             {canvasId}                                   ASK-ONLY
 *   share_canvas              {canvasId}                                   CONSEQUENTIAL + NEVER-AUTONOMOUS (public exposure)
 *   revoke_canvas_share       {canvasId}                                   MUTATING, non-consequential
 *   archive_project           {projectId, archived}                        MUTATING, non-consequential (owner; lossless, 409 while running)
 *   get_preferences           {}                                           READ
 *   set_preferences        {codingModel?, codingPermissionMode?, devContainerEnabled?}  MUTATING; REQUIRES a live user turn
 *
 * Every executor delegates to the same service/prisma shape the REST twins
 * use. Import-light: heavy modules ride dynamic imports.
 */
import { rateKeys, consumeRateSlots, KNOWLEDGE_CAPS } from './account-tools';

// (The feed lifecycle tools set_feed / refresh_feed / delete_feed were retired
// 2026-10-20, ticket 43c24152 — topic digests are schedule_message on a real
// chat now; this group keeps every other housekeeping tool.)
export const HOUSEKEEPING_TOOL_NAMES = ['remove_knowledge_document', 'add_knowledge_file', 'add_knowledge_gmail', 'create_canvas', 'delete_canvas', 'share_canvas', 'revoke_canvas_share', 'archive_project', 'get_preferences', 'set_preferences'] as const;
export type HousekeepingToolName = (typeof HOUSEKEEPING_TOOL_NAMES)[number];
export const isHousekeepingTool = (name: string): name is HousekeepingToolName => (HOUSEKEEPING_TOOL_NAMES as readonly string[]).includes(name);

const CANVAS_TYPES = new Set(['document', 'code', 'html', 'mermaid', 'table']);
const CANVAS_CONTENT_MAX = 400_000;
const KNOWLEDGE_FILE_MAX_BYTES = 30 * 1024 * 1024;
const OS_CODING = ['glm-5.3', 'deepseek-flash', 'kimi-k3'];
const CONFIRMATION_ID_PARAM = { type: 'string', description: 'Pass back the confirmationId from the staged card once the user confirmed (consequential tools only).' };

export const HOUSEKEEPING_TOOL_SCHEMA = [
  { type: 'function' as const, function: { name: 'remove_knowledge_document', description: "REMOVE a document from a project's knowledge base (its chunks go with it — future chats stop grounding on it). ASK-ONLY: a human approves every call. Only the user who added the document can remove it. list_knowledge_documents gives the ids. WHEN: a wrong add_knowledge_url, a stale source, \"forget that PDF\".", parameters: { type: 'object', properties: { documentId: { type: 'string', description: 'The document id from list_knowledge_documents.' } }, required: ['documentId'] } } },
  { type: 'function' as const, function: { name: 'add_knowledge_file', description: "File a BINARY or generated file into a project's knowledge base (RAG) — a generated xlsx/pdf/docx of yours (fileId from create_document) or a staged upload (uploadId from stage_upload / the user's upload). Text is extracted (PDF/DOCX/text; images are vision-described) and ingested like an uploaded document. projectId omitted = this chat's project. Editor+ on the project; the knowledge caps apply (10/hour per chat, 50/day per user, 200 docs per project). Not consequential.", parameters: { type: 'object', properties: { fileId: { type: 'string' }, uploadId: { type: 'string' }, projectId: { type: 'string' }, name: { type: 'string', description: 'Display name (default: the filename).' } } } } },
  { type: 'function' as const, function: { name: 'add_knowledge_gmail', description: "File a GMAIL ATTACHMENT into a project's knowledge base (RAG) — fetches it by messageId + filename (from gmail_search / gmail_get_message results), extracts text (PDF/DOCX via the shared extractors, images via the vision hop) and ingests it like an uploaded document. DEDUPED by messageId+filename: re-adding the same attachment returns the existing document. projectId omitted = this chat's project. Editor+ on the project; the knowledge caps apply. Use it when the user says \"save this attachment to the project\" — no re-upload needed.", parameters: { type: 'object', properties: { messageId: { type: 'string', description: 'Gmail message id the attachment belongs to (from gmail_search / gmail_get_message).' }, filename: { type: 'string', description: 'Attachment filename — the preferred, stable handle (gmail-mcp resolves by filename).' }, projectId: { type: 'string', description: 'Defaults to this chat\'s project; a chat not in a project must pass it (list_projects resolves names).' }, label: { type: 'string', description: 'Connected Google account label/email when several are connected (from googleApi account list).' }, name: { type: 'string', description: 'Display name (default: the filename).' } }, required: ['messageId', 'filename'] } } },
  { type: 'function' as const, function: { name: 'create_canvas', description: "Create a canvas (a persistent artifact the user can open in the side panel): title, type document|code|html|mermaid|table, language (code only), content (≤ 400,000 chars). chatId omitted = this chat (must be a chat you own). Use it for deliverables the user will keep or edit — prefer the answer's own canvas markers when you are writing an answer; this tool is for explicit \"make this a canvas\" / cross-chat work. Not consequential.", parameters: { type: 'object', properties: { title: { type: 'string' }, type: { type: 'string', enum: ['document', 'code', 'html', 'mermaid', 'table'] }, language: { type: 'string' }, content: { type: 'string' }, chatId: { type: 'string' } }, required: ['title', 'content'] } } },
  { type: 'function' as const, function: { name: 'delete_canvas', description: "DELETE a canvas (and its share link). ASK-ONLY: a human approves every call. Owner-scoped; list_canvases gives the ids.", parameters: { type: 'object', properties: { canvasId: { type: 'string' } }, required: ['canvasId'] } } },
  { type: 'function' as const, function: { name: 'share_canvas', description: "Publish a canvas at a PUBLIC read-only link (anyone with the URL can read it). NEVER autonomous: every call stages a confirmation the user must accept in a new message — no auto-mode bypass, no autonomy grant, no machine run. Returns the share URL after confirmation. Owner-scoped. Undo with revoke_canvas_share.", parameters: { type: 'object', properties: { canvasId: { type: 'string' }, confirmationId: CONFIRMATION_ID_PARAM }, required: ['canvasId'] } } },
  { type: 'function' as const, function: { name: 'revoke_canvas_share', description: "Turn a canvas's public link OFF (the URL stops working). Owner-scoped; idempotent; not consequential.", parameters: { type: 'object', properties: { canvasId: { type: 'string' } }, required: ['canvasId'] } } },
  { type: 'function' as const, function: { name: 'archive_project', description: "Archive (archived:true) or restore (archived:false) a whole project folder — the folder, its chats and subfolders leave the default lists; restore brings the subtree back in place, nothing is deleted. Archiving is refused (409) while a coding session in the folder is running or a non-supervisor schedule is enabled — stop/pause them first; a project supervisor lane is paused with its project. Owner-only; the personal Workspace folder cannot be archived. Not consequential.", parameters: { type: 'object', properties: { projectId: { type: 'string' }, archived: { type: 'boolean' } }, required: ['projectId', 'archived'] } } },
  { type: 'function' as const, function: { name: 'get_preferences', description: "Read the user's account defaults: codingModel (the default agent for NEW coding sessions), codingPermissionMode (auto|plan|ask — the default Agent mode), devContainerEnabled (shared tailnet dev container), modelSet. Read-only, never gated.", parameters: { type: 'object', properties: {} } } },
  { type: 'function' as const, function: { name: 'set_preferences', description: "Change the user's account defaults: codingModel (a built-in coding model or a <label>:<modelId> custom endpoint model), codingPermissionMode (auto|plan|ask), devContainerEnabled (boolean). Applies to NEW sessions (an existing session keeps its own — set_session_model / set_session_permission_mode change those). ONLY from a live user request (\"make GLM my default\", \"default new sessions to plan mode\") — a scheduled/automatic run may never change account-wide defaults (refused with no_user_turn). Audited.", parameters: { type: 'object', properties: { codingModel: { type: 'string' }, codingPermissionMode: { type: 'string', enum: ['auto', 'plan', 'ask'] }, devContainerEnabled: { type: 'boolean' } } } } },
];

type Ctx = { sessionId: string; userId: string; userTurnAt?: Date | null; projectId?: string | null; anonymous?: boolean };
type Deps = { platform: any };
const out = (o: Record<string, unknown>): string => JSON.stringify(o, null, 1);
const short = (s: string) => String(s || '').slice(0, 8);
async function db(): Promise<any> { return (await import('../../../config/database')).default; }
async function audit(userId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  try { const prisma = await db(); await prisma.activity.create({ data: { userId, action, resource: 'platform', metadata } }); } catch { /* audit must never fail the tool */ }
}
const isAnon = (ctx: Ctx) => !!ctx.anonymous || !ctx.userId || String(ctx.userId).startsWith('anon');
const refuseAnon = (name: string) => out({ ok: false, tool: name, reason: 'anonymous', message: `${name} needs a signed-in user — this chat is anonymous.` });

export async function executeHousekeepingTool(ctx: Ctx, name: HousekeepingToolName, args: any, deps: Deps): Promise<string> {
  const { platform } = deps;
  const userId = ctx.userId;
  if (isAnon(ctx)) return refuseAnon(name);
  switch (name) {
    case 'remove_knowledge_document': {
      const documentId = String(args?.documentId || '').trim();
      if (!documentId) return out({ ok: false, tool: name, reason: 'invalid', message: 'documentId is required (list_knowledge_documents).' });
      const prisma = await db();
      const doc = await prisma.projectDocument.findUnique({ where: { id: documentId }, select: { id: true, userId: true, projectId: true, name: true } }).catch(() => null);
      if (!doc || doc.userId !== userId) return out({ ok: false, tool: name, ids: { documentId }, reason: 'not_found', message: 'No knowledge document you added matches that id (only the user who added a document can remove it).' });
      await prisma.projectDocument.delete({ where: { id: documentId } }); // chunks cascade via FK
      await audit(userId, 'knowledge.remove', { documentId, projectId: doc.projectId, name: doc.name });
      return out({ ok: true, tool: name, ids: { documentId, projectId: doc.projectId }, message: `Removed "${doc.name}" from the knowledge base (its chunks are gone; future chats no longer ground on it).` });
    }
    case 'add_knowledge_file': {
      const fileId = String(args?.fileId || '').trim();
      const uploadId = String(args?.uploadId || '').trim();
      if ((fileId ? 1 : 0) + (uploadId ? 1 : 0) !== 1) return out({ ok: false, tool: name, reason: 'invalid', message: 'Pass exactly ONE of fileId or uploadId.' });
      const projectId = String(args?.projectId || '').trim() || (ctx.projectId && ctx.projectId !== 'chat' ? ctx.projectId : '');
      if (!projectId) return out({ ok: false, tool: name, reason: 'no_project', message: 'This chat is not in a project — pass projectId (list_projects).' });
      const access = await platform.getProjectAccess(projectId, userId);
      if (!access) return out({ ok: false, tool: name, ids: { projectId }, reason: 'not_found', message: 'Project not found or no access.' });
      if (access.role === 'viewer') return out({ ok: false, tool: name, ids: { projectId }, reason: 'forbidden', message: 'You are a viewer on that project — only owners/editors/admins add knowledge.' });
      const prisma = await db();
      let buffer: Buffer; let filename: string; let mimeType: string; let text: string | null = null;
      if (fileId) {
        const row = await prisma.generatedFile.findFirst({ where: { id: fileId, userId }, select: { filename: true, mimeType: true, data: true, textContent: true, size: true } }).catch(() => null);
        if (!row) return out({ ok: false, tool: name, reason: 'not_found', message: 'No generated file of yours matches that fileId.' });
        buffer = Buffer.from(String(row.data || ''), 'base64'); filename = row.filename; mimeType = row.mimeType || 'application/octet-stream'; text = row.textContent || null;
      } else {
        const up: any = await import('../upload.controller');
        const att = await up.loadAttachment(uploadId);
        if (!att || (att.ownerUserId != null && att.ownerUserId !== userId)) return out({ ok: false, tool: name, reason: 'not_found', message: 'No staged upload of yours matches that uploadId (blobs live 15 minutes).' });
        buffer = Buffer.from(String(att.base64 || ''), 'base64'); filename = att.filename || 'upload'; mimeType = att.mimeType || (att.type === 'pdf' ? 'application/pdf' : att.type === 'image' ? 'image/png' : 'text/plain'); text = att.extractedText || null;
      }
      if (buffer.length > KNOWLEDGE_FILE_MAX_BYTES) return out({ ok: false, tool: name, reason: 'too_large', message: `The file is ${buffer.length} bytes — the knowledge limit is ${KNOWLEDGE_FILE_MAX_BYTES}.` });
      const docCount = await prisma.projectDocument.count({ where: { projectId } });
      if (docCount >= KNOWLEDGE_CAPS.docsPerProject) return out({ ok: false, tool: name, ids: { projectId }, reason: 'project_full', message: `The project already has ${docCount} documents (cap ${KNOWLEDGE_CAPS.docsPerProject}).` });
      try {
        const redis = (await import('../../../config/redis')).default;
        const { dayKey, hourKey } = rateKeys('knowledge', userId, ctx.sessionId);
        const gate = await consumeRateSlots(redis as any, [
          { key: hourKey, cap: KNOWLEDGE_CAPS.chatHourly, ttlSec: KNOWLEDGE_CAPS.hourKeyTtl, scope: 'chat_hourly' },
          { key: dayKey, cap: KNOWLEDGE_CAPS.userDaily, ttlSec: KNOWLEDGE_CAPS.dayKeyTtl, scope: 'user_daily' },
        ]);
        if (!gate.ok) return out({ ok: false, tool: name, reason: 'rate_limited', scope: gate.scope, message: gate.scope === 'chat_hourly' ? `This chat already added ${KNOWLEDGE_CAPS.chatHourly} knowledge documents this hour.` : `The user already added ${KNOWLEDGE_CAPS.userDaily} knowledge documents today.` });
      } catch { /* cap check unavailable — allow (user-scoped) */ }
      if (!text || !text.trim()) {
        try {
          if (/^image\//i.test(mimeType)) {
            const dc: any = await import('../documents.controller');
            text = await dc.describeImageForKnowledgeBase(buffer, mimeType, filename);
          } else {
            const ing: any = await import('../ingestion.service');
            text = await ing.extractTextFromBuffer(buffer, mimeType, filename);
          }
        } catch (err: any) {
          return out({ ok: false, tool: name, reason: 'unreadable', message: String(err?.message || err) });
        }
      }
      if (!text || !text.trim()) return out({ ok: false, tool: name, reason: 'unreadable', message: 'Could not extract any text from that file.' });
      const displayName = (typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : filename).slice(0, KNOWLEDGE_CAPS.nameMax);
      const doc = await prisma.projectDocument.create({ data: { projectId, userId, name: displayName, mimeType, status: 'processing', charCount: text.length, source: 'knowledge' } });
      const body = text;
      import('../ingestion.service').then((m: any) => m.processDocument(doc.id, body)).catch(() => {});
      await audit(userId, 'knowledge.add_file', { documentId: doc.id, projectId, name: displayName, bytes: buffer.length });
      return out({ ok: true, tool: name, ids: { documentId: doc.id, projectId }, name: displayName, mimeType, charCount: text.length, status: 'processing', message: `Filed "${displayName}" into the project's knowledge base — ingestion runs in the background; list_knowledge_documents shows ready|error.` });
    }
    case 'add_knowledge_gmail': {
      // Gmail→KB (ticket 99145890): the GMAIL-SOURCE leg — messageId+filename
      // from gmail_search/gmail_get_message, deduped by messageId+filename.
      const messageId = String(args?.messageId || '').trim();
      const filename  = String(args?.filename  || '').trim();
      if (!messageId || !filename) return out({ ok: false, tool: name, reason: 'invalid', message: 'messageId and filename are both required (from gmail_search / gmail_get_message).' });
      const projectId = String(args?.projectId || '').trim() || (ctx.projectId && ctx.projectId !== 'chat' ? ctx.projectId : '');
      if (!projectId) return out({ ok: false, tool: name, reason: 'no_project', message: 'This chat is not in a project — pass projectId (list_projects).' });
      const access = await platform.getProjectAccess(projectId, userId);
      if (!access) return out({ ok: false, tool: name, ids: { projectId }, reason: 'not_found', message: 'Project not found or no access.' });
      if (access.role === 'viewer') return out({ ok: false, tool: name, ids: { projectId }, reason: 'forbidden', message: 'You are a viewer on that project — only owners/editors/admins add knowledge.' });
      const svc: any = await import('../gmail-knowledge.service');
      const result = await svc.ingestGmailAttachment({
        projectId, userId, messageId, filename,
        sessionId: ctx.sessionId,
        label: args?.label ? String(args.label) : undefined,
      });
      if (result.outcome === 'error') {
        return out({ ok: false, tool: name, ids: { projectId, messageId }, reason: result.reason, message: result.message });
      }
      if (result.outcome === 'duplicate') {
        return out({ ok: true, tool: name, ids: { documentId: result.documentId, projectId }, duplicate: true, name: result.name, status: result.status, message: `"${result.name}" is already in the project's knowledge base (dedup by messageId+filename) — status ${result.status}.` });
      }
      await audit(userId, 'knowledge.add_gmail', { documentId: result.documentId, projectId, messageId, filename, name: result.name });
      return out({ ok: true, tool: name, ids: { documentId: result.documentId, projectId }, name: result.name, charCount: result.charCount, status: result.status, message: `Filed Gmail attachment "${result.name}" into the project's knowledge base — extraction and ingestion run in the background; list_knowledge_documents shows ready|error.` });
    }
    case 'create_canvas': {
      const title = String(args?.title || '').trim().slice(0, 200);
      const content = typeof args?.content === 'string' ? args.content : '';
      if (!title || !content) return out({ ok: false, tool: name, reason: 'invalid', message: 'title and content are required.' });
      if (content.length > CANVAS_CONTENT_MAX) return out({ ok: false, tool: name, reason: 'too_large', message: `content must be ≤ ${CANVAS_CONTENT_MAX} characters.` });
      const type = String(args?.type || 'document');
      if (!CANVAS_TYPES.has(type)) return out({ ok: false, tool: name, reason: 'invalid', message: 'type must be document | code | html | mermaid | table.' });
      const raw = String(args?.chatId || '').trim() || ctx.sessionId;
      const chatId = raw === ctx.sessionId ? raw : (typeof platform?.resolveOwnedChatIdPrefix === 'function' ? await platform.resolveOwnedChatIdPrefix(userId, raw).catch(() => raw) : raw);
      const prisma = await db();
      const chat = await prisma.crossModelChat.findFirst({ where: { id: chatId, userId }, select: { id: true } }).catch(() => null);
      if (!chat) return out({ ok: false, tool: name, ids: { chatId }, reason: 'not_found', message: 'No chat you own matches that id.' });
      const canvas = await prisma.canvasDocument.create({ data: { chatId, userId, title, type, language: type === 'code' && typeof args?.language === 'string' ? args.language.trim().slice(0, 40) || null : null, content, version: 1 }, select: { id: true, title: true, type: true, version: true } });
      return out({ ok: true, tool: name, ids: { canvasId: canvas.id, chatId }, canvas, message: `Created canvas "${canvas.title}" (${canvas.type}) ${short(canvas.id)} on chat ${short(chatId)} — the user opens it from the canvas panel.` });
    }
    case 'delete_canvas': {
      const canvasId = String(args?.canvasId || '').trim();
      if (!canvasId) return out({ ok: false, tool: name, reason: 'invalid', message: 'canvasId is required (list_canvases).' });
      const prisma = await db();
      const existing = await prisma.canvasDocument.findFirst({ where: { id: canvasId, userId }, select: { id: true, title: true } }).catch(() => null);
      if (!existing) return out({ ok: false, tool: name, ids: { canvasId }, reason: 'not_found', message: 'No canvas you own matches that id.' });
      await prisma.canvasDocument.delete({ where: { id: canvasId } });
      await audit(userId, 'canvas.delete', { canvasId, title: existing.title });
      return out({ ok: true, tool: name, ids: { canvasId }, message: `Deleted canvas "${existing.title}".` });
    }
    case 'share_canvas': {
      const canvasId = String(args?.canvasId || '').trim();
      if (!canvasId) return out({ ok: false, tool: name, reason: 'invalid', message: 'canvasId is required (list_canvases).' });
      const prisma = await db();
      const canvas = await prisma.canvasDocument.findFirst({ where: { id: canvasId, userId }, select: { id: true, title: true } }).catch(() => null);
      if (!canvas) return out({ ok: false, tool: name, ids: { canvasId }, reason: 'not_found', message: 'No canvas you own matches that id.' });
      const { randomBytes } = await import('crypto');
      const link = await prisma.canvasShareLink.upsert({ where: { canvasId }, create: { canvasId, shareToken: randomBytes(20).toString('hex'), isActive: true }, update: { isActive: true } });
      await audit(userId, 'canvas.share', { canvasId, title: canvas.title });
      return out({ ok: true, tool: name, ids: { canvasId }, url: `/api/crossmodel/shared/canvas/${link.shareToken}`, message: `Canvas "${canvas.title}" is PUBLIC at /api/crossmodel/shared/canvas/${link.shareToken} — anyone with the link can read it; revoke_canvas_share turns it off.` });
    }
    case 'revoke_canvas_share': {
      const canvasId = String(args?.canvasId || '').trim();
      if (!canvasId) return out({ ok: false, tool: name, reason: 'invalid', message: 'canvasId is required.' });
      const prisma = await db();
      const canvas = await prisma.canvasDocument.findFirst({ where: { id: canvasId, userId }, select: { id: true } }).catch(() => null);
      if (!canvas) return out({ ok: false, tool: name, ids: { canvasId }, reason: 'not_found', message: 'No canvas you own matches that id.' });
      const r = await prisma.canvasShareLink.updateMany({ where: { canvasId, isActive: true }, data: { isActive: false } });
      await audit(userId, 'canvas.share.revoke', { canvasId });
      return out({ ok: true, tool: name, ids: { canvasId }, revoked: r.count > 0, message: r.count > 0 ? 'The public link no longer works.' : 'That canvas had no active public link.' });
    }
    case 'archive_project': {
      const projectId = String(args?.projectId || '').trim();
      if (!projectId || typeof args?.archived !== 'boolean') return out({ ok: false, tool: name, reason: 'invalid', message: 'projectId and archived (boolean) are required.' });
      try {
        const r = await platform.archiveProject({ userId, projectId, archived: args.archived });
        return out({ ok: true, tool: name, ids: { projectId }, archived: r.archived, message: r.archived ? `Project ${short(projectId)} archived — its subtree leaves the default lists; archive_project {archived:false} restores it.` : `Project ${short(projectId)} restored.` });
      } catch (err: any) {
        const status = Number(err?.statusCode ?? err?.status ?? 0);
        return out({ ok: false, tool: name, ids: { projectId }, reason: status === 404 ? 'not_found' : status === 409 ? 'busy' : status === 400 ? 'refused' : 'error', message: String(err?.message || err) });
      }
    }
    case 'get_preferences': {
      const prisma = await db();
      const prefs = await prisma.userPreferences.findUnique({ where: { userId } }).catch(() => null);
      const alias: Record<string, string> = { 'kimi-k2.6': 'kimi-k3', 'glm-5.2': 'glm-5.3', 'deepseek-v4-pro': 'deepseek-flash', 'deepseek-v4-flash': 'deepseek-flash' };
      const cm = prefs?.codingModel ? (alias[prefs.codingModel] || prefs.codingModel) : 'glm-5.3';
      return out({ ok: true, tool: name, preferences: { modelSet: prefs?.modelSet || 'open_source', codingModel: cm, codingPermissionMode: prefs?.codingPermissionMode || 'auto', devContainerEnabled: prefs?.devContainerEnabled ?? false } });
    }
    case 'set_preferences': {
      if (!ctx.userTurnAt) return out({ ok: false, tool: name, reason: 'no_user_turn', message: 'Account defaults change only from a live user request — a scheduled/automatic run may not rewrite them. Suggest it in the answer and let the user ask.' });
      const data: any = {};
      if (args?.codingModel !== undefined) {
        const m = String(args.codingModel || '').trim();
        // '' = follow the admin's Workspace default seat (seats govern sessions, 2026-09-28).
        if (m && !OS_CODING.includes(m)) {
          const reg: any = await import('../model-endpoints/model-endpoints.service').then((mod: any) => mod.resolveRegistryModel(m, userId)).catch(() => null);
          if (!reg?.coding) return out({ ok: false, tool: name, reason: 'invalid', message: `codingModel must be one of ${OS_CODING.join(', ')} or a "<label>:<modelId>" coding-capable custom endpoint model.` });
        }
        data.codingModel = m;
      }
      if (args?.codingPermissionMode !== undefined) {
        const pm = String(args.codingPermissionMode);
        if (!['auto', 'plan', 'ask'].includes(pm)) return out({ ok: false, tool: name, reason: 'invalid', message: 'codingPermissionMode must be auto | plan | ask.' });
        data.codingPermissionMode = pm;
      }
      if (args?.devContainerEnabled !== undefined) {
        if (typeof args.devContainerEnabled !== 'boolean') return out({ ok: false, tool: name, reason: 'invalid', message: 'devContainerEnabled must be a boolean.' });
        data.devContainerEnabled = args.devContainerEnabled;
      }
      if (!Object.keys(data).length) return out({ ok: false, tool: name, reason: 'invalid', message: 'Nothing to change — pass codingModel, codingPermissionMode and/or devContainerEnabled.' });
      const prisma = await db();
      const prefs = await prisma.userPreferences.upsert({ where: { userId }, update: data, create: { userId, ...data } });
      // The user asked for this mode on a live turn (gated above) — mark it
      // DELIBERATE for human-turn spawns (platform/human-spawn.ts).
      if (data.codingPermissionMode !== undefined) {
        await import('./human-spawn').then((m) => m.markPermissionModeExplicit(userId, data.codingPermissionMode, 'set_preferences')).catch(() => {});
      }
      // Seats govern sessions (2026-09-28): a coding model the user asked for on a live turn is an
      // EXPLICIT pick (the marker names the stored value); '' / the schema default clears it.
      if (data.codingModel !== undefined) {
        await import('../coding/seat-governance').then((m) => m.markCodingModelExplicit(userId, data.codingModel, 'set_preferences')).catch(() => {});
      }
      await audit(userId, 'preferences.update', { ...data, via: 'tool', chatId: ctx.sessionId });
      return out({ ok: true, tool: name, preferences: { codingModel: prefs.codingModel, codingPermissionMode: prefs.codingPermissionMode, devContainerEnabled: prefs.devContainerEnabled ?? false }, message: `Account defaults updated (${Object.keys(data).join(', ')}) — new coding sessions use them; existing sessions keep their own settings.` });
    }
    default:
      return out({ ok: false, tool: name, reason: 'unknown', message: `Unknown housekeeping tool ${name}.` });
  }
}
