/**
 * Self-service tools — agent capability gap audit, tranche 5
 * (P3 #36, #37, #38, #39; 2026-09-24):
 *
 *   consolidate_memory     {}                                MUTATING; live user turn required (account-wide)
 *   rebuild_memory         {}                                MUTATING; live user turn required; background job (Redis NX lock)
 *   memory_rebuild_status  {}                                READ
 *   delete_document        {fileId}                          ASK-ONLY (a generated file of yours)
 *   list_chat_uploads      {chatId?}                         READ, chat read access
 *   read_chat_upload       {chatFileId, offset?, limit?}     READ, chat read access (text extracted like the Files panel preview)
 *   delete_chat_upload     {chatFileId}                      ASK-ONLY (uploader only)
 *   share_project          {projectId, enable}               CONSEQUENTIAL + NEVER-AUTONOMOUS (public exposure)
 *   add_project_member     {projectId, email, role}          CONSEQUENTIAL + NEVER-AUTONOMOUS (grants another user access)
 *   remove_project_member  {projectId, userId|email}         CONSEQUENTIAL + NEVER-AUTONOMOUS
 *   resolve_feedback       {id}                              MUTATING, non-consequential (the filer closes their OWN ticket)
 *
 * (#35 — view 'deploy' with an explicit repo for any signed-in caller, and
 * #39's own-tickets listing, live in the get_fleet_telemetry / list_feedback
 * branches of platform-tools.ts.) Import-light: heavy modules ride dynamic
 * imports.
 */

export const SELF_SERVICE_TOOL_NAMES = ['consolidate_memory', 'rebuild_memory', 'memory_rebuild_status', 'delete_document', 'list_chat_uploads', 'read_chat_upload', 'delete_chat_upload', 'share_project', 'add_project_member', 'remove_project_member', 'resolve_feedback'] as const;
export type SelfServiceToolName = (typeof SELF_SERVICE_TOOL_NAMES)[number];
export const isSelfServiceTool = (name: string): name is SelfServiceToolName => (SELF_SERVICE_TOOL_NAMES as readonly string[]).includes(name);

export const CHAT_UPLOAD_TEXT_MAX = 50_000;
const MEMBER_ROLES = new Set(['viewer', 'editor', 'admin']);
const CONFIRMATION_ID_PARAM = { type: 'string', description: 'Pass back the confirmationId from the staged card once the user confirmed (consequential tools only).' };

export const SELF_SERVICE_TOOL_SCHEMA = [
  { type: 'function' as const, function: { name: 'consolidate_memory', description: "Consolidate the user's memory profile NOW (merge duplicates, tighten wording, fold in what recent chats reveal) — the Account page's Consolidate button. ONLY from a live user request (\"clean up what you know about me\"); a scheduled/automatic run may not rewrite account memory (refused with no_user_turn). Returns the fact count after.", parameters: { type: 'object', properties: {} } } },
  { type: 'function' as const, function: { name: 'rebuild_memory', description: "REBUILD the user's memory from their past conversations (up to 600 exchanges, background job, a few minutes) — the recovery path after a memory wipe. ONLY from a live user request; refused with already_running while a rebuild is in flight. memory_rebuild_status reports progress.", parameters: { type: 'object', properties: {} } } },
  { type: 'function' as const, function: { name: 'memory_rebuild_status', description: "Progress of the user's memory rebuild (running, processed/total, facts before/after, error) plus the current fact count. Read-only.", parameters: { type: 'object', properties: {} } } },
  { type: 'function' as const, function: { name: 'delete_document', description: "DELETE a generated file of yours (create_document output) — frees its storage quota. ASK-ONLY: a human approves every call. list_files gives the ids.", parameters: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] } } },
  { type: 'function' as const, function: { name: 'list_chat_uploads', description: "List the files the user uploaded to a chat (id, filename, mimeType, sizeBytes, uploadedAt) — durable rows, not the 15-minute staging blobs; readable weeks later. chatId omitted = this chat. Chat read access (owner or project member).", parameters: { type: 'object', properties: { chatId: { type: 'string' } } } } },
  { type: 'function' as const, function: { name: 'read_chat_upload', description: "Read the TEXT of a file uploaded to a chat (text/JSON/XML as-is; PDF, DOCX, XLSX extracted — the Files panel's preview) by its chatFileId from list_chat_uploads. offset/limit page the text (limit ≤ 50,000). Images and other binaries have no text (refused). Chat read access.", parameters: { type: 'object', properties: { chatFileId: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['chatFileId'] } } },
  { type: 'function' as const, function: { name: 'delete_chat_upload', description: "DELETE a file the user uploaded to a chat (only the uploader can). ASK-ONLY: a human approves every call.", parameters: { type: 'object', properties: { chatFileId: { type: 'string' } }, required: ['chatFileId'] } } },
  { type: 'function' as const, function: { name: 'share_project', description: "Turn a project's PUBLIC share link on (enable:true — returns the URL; anyone with it can read the project) or off (enable:false). NEVER autonomous: every call stages a confirmation the user accepts in a new message — no auto-mode bypass, no autonomy grant, no machine run. Owner-only.", parameters: { type: 'object', properties: { projectId: { type: 'string' }, enable: { type: 'boolean' }, confirmationId: CONFIRMATION_ID_PARAM }, required: ['projectId', 'enable'] } } },
  { type: 'function' as const, function: { name: 'add_project_member', description: "Invite another Digby user (by email) to a project as viewer | editor | admin, or change an existing member's role. NEVER autonomous: it grants another person access — every call stages a confirmation the user accepts in a new message. Owner or admin member. The invitee must already have a Digby account.", parameters: { type: 'object', properties: { projectId: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', enum: ['viewer', 'editor', 'admin'] }, confirmationId: CONFIRMATION_ID_PARAM }, required: ['projectId', 'email'] } } },
  { type: 'function' as const, function: { name: 'remove_project_member', description: "Remove a member from a project (by their userId or email). NEVER autonomous: a confirmation the user accepts in a new message. Owner removes anyone; a member may remove themselves.", parameters: { type: 'object', properties: { projectId: { type: 'string' }, userId: { type: 'string' }, email: { type: 'string' }, confirmationId: CONFIRMATION_ID_PARAM }, required: ['projectId'] } } },
  { type: 'function' as const, function: { name: 'resolve_feedback', description: "Mark a feedback ticket the user FILED THEMSELVES as resolved (status done) — the 'this is fixed / no longer needed' self-close. Filer-only (admins use update_feedback). list_feedback shows the user's own tickets. Not consequential.", parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } },
];

type Ctx = { sessionId: string; userId: string; userTurnAt?: Date | null; anonymous?: boolean };
type Deps = { platform: any };
const out = (o: Record<string, unknown>): string => JSON.stringify(o, null, 1);
const short = (s: string) => String(s || '').slice(0, 8);
async function db(): Promise<any> { return (await import('../../../config/database')).default; }
async function audit(userId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  try { const prisma = await db(); await prisma.activity.create({ data: { userId, action, resource: 'platform', metadata } }); } catch { /* never fails the tool */ }
}
const isAnon = (ctx: Ctx) => !!ctx.anonymous || !ctx.userId || String(ctx.userId).startsWith('anon');
async function chatReadable(chatId: string, userId: string): Promise<boolean> {
  const cm: any = (await import('../crossmodel.service')).default;
  const { chatReadAccessGranted } = await import('../chat-agent/chat-gate');
  const r = await cm.getChatAccess(chatId, userId).catch(() => ({ access: 'none', exists: false }));
  return chatReadAccessGranted({ userId, access: r.access, exists: r.exists });
}
async function ownedProject(userId: string, projectId: string): Promise<any | null> {
  const prisma = await db();
  const p = await prisma.crossModelProject.findUnique({ where: { id: projectId } }).catch(() => null);
  return p && p.userId === userId ? p : null;
}
/** Framework surface (ticket 9471d338) — is this row the platform's own project? */
async function isFrameworkRow(p: any): Promise<boolean> {
  if (!p) return false;
  const { isFrameworkProjectRow, instanceOwnRepoSlugSoft } = await import('./framework-project');
  return isFrameworkProjectRow(p, instanceOwnRepoSlugSoft());
}
async function frameworkRefusal(action: 'share' | 'member'): Promise<string> {
  const { frameworkGuardMessage } = await import('./framework-project');
  return frameworkGuardMessage(action);
}

export async function executeSelfServiceTool(ctx: Ctx, name: SelfServiceToolName, args: any, deps: Deps): Promise<string> {
  const { platform } = deps;
  const userId = ctx.userId;
  if (isAnon(ctx)) return out({ ok: false, tool: name, reason: 'anonymous', message: `${name} needs a signed-in user — this chat is anonymous.` });
  switch (name) {
    case 'consolidate_memory': {
      if (!ctx.userTurnAt) return out({ ok: false, tool: name, reason: 'no_user_turn', message: 'Memory consolidation runs only from a live user request — a scheduled/automatic run may not rewrite account memory.' });
      const contextService: any = (await import('../context.service')).default;
      const cm: any = (await import('../crossmodel.service')).default;
      const moonshot: any = (await import('../integrations/moonshot.integration')).default;
      const currentFacts = await contextService.getUserMemory(userId);
      const recent = await cm.listChats(userId, 1, 10);
      const titles: string[] = (recent?.chats ?? []).map((c: any) => c.title);
      if (!Object.keys(currentFacts || {}).length && !titles.length) return out({ ok: true, tool: name, consolidated: 0, facts: 0, message: 'Nothing to consolidate yet — no facts and no chats.' });
      const consolidated = await moonshot.consolidateMemory(currentFacts, titles);
      for (const [k, v] of Object.entries(consolidated || {})) await contextService.updateMemoryFact(userId, String(k).toLowerCase().replace(/\s+/g, '_'), String(v));
      const after = await contextService.getUserMemory(userId);
      await audit(userId, 'memory.consolidate', { via: 'tool', chatId: ctx.sessionId, updated: Object.keys(consolidated || {}).length });
      return out({ ok: true, tool: name, consolidated: Object.keys(consolidated || {}).length, facts: Object.keys(after || {}).length, message: `Profile consolidated — ${Object.keys(consolidated || {}).length} fact(s) updated; ${Object.keys(after || {}).length} facts now.` });
    }
    case 'rebuild_memory': {
      if (!ctx.userTurnAt) return out({ ok: false, tool: name, reason: 'no_user_turn', message: 'A memory rebuild starts only from a live user request.' });
      const { startUserMemoryRebuild } = await import('../langgraph/memory.graph');
      const r = await startUserMemoryRebuild(userId);
      if (!r.started) return out({ ok: false, tool: name, reason: r.reason ?? 'refused', message: r.reason === 'already_running' ? 'A rebuild is already running — memory_rebuild_status shows progress.' : 'No past conversations to rebuild from yet.' });
      await audit(userId, 'memory.rebuild', { via: 'tool', chatId: ctx.sessionId, total: r.total });
      return out({ ok: true, tool: name, started: true, total: r.total, message: `Rebuilding memory from ${r.total} past exchange(s) in the background — memory_rebuild_status reports progress.` });
    }
    case 'memory_rebuild_status': {
      const { getUserMemoryRebuildStatus } = await import('../langgraph/memory.graph');
      const s = await getUserMemoryRebuildStatus(userId);
      return out({ ok: true, tool: name, ...s, message: s.running ? `Rebuild running: ${s.status?.processed ?? 0}/${s.status?.total ?? 0} exchanges processed.` : s.status ? `Last rebuild finished ${s.status.finishedAt}: ${s.status.factsBefore} → ${s.status.factsAfter ?? '?'} facts${s.status.error ? ` (error: ${s.status.error})` : ''}.` : `No rebuild on record; ${s.facts} facts today.` });
    }
    case 'delete_document': {
      const fileId = String(args?.fileId || '').trim();
      if (!fileId) return out({ ok: false, tool: name, reason: 'invalid', message: 'fileId is required (list_files).' });
      const prisma = await db();
      const file = await prisma.generatedFile.findFirst({ where: { id: fileId, userId }, select: { id: true, filename: true, size: true } }).catch(() => null);
      if (!file) return out({ ok: false, tool: name, ids: { fileId }, reason: 'not_found', message: 'No generated file of yours matches that id.' });
      await prisma.generatedFile.delete({ where: { id: file.id } });
      await audit(userId, 'generated_file.delete', { fileId, filename: file.filename, bytes: file.size, via: 'tool' });
      return out({ ok: true, tool: name, ids: { fileId }, message: `Deleted ${file.filename} (${file.size} bytes freed).` });
    }
    case 'list_chat_uploads': {
      const raw = String(args?.chatId || '').trim() || ctx.sessionId;
      const chatId = raw === ctx.sessionId ? raw : (typeof platform?.resolveOwnedChatIdPrefix === 'function' ? await platform.resolveOwnedChatIdPrefix(userId, raw).catch(() => raw) : raw);
      if (!(await chatReadable(chatId, userId))) return out({ ok: false, tool: name, ids: { chatId }, reason: 'not_found', message: 'No chat you can read matches that id.' });
      const prisma = await db();
      const files = await prisma.chatFile.findMany({ where: { chatId }, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true, userId: true } }).catch(() => []);
      return out({ ok: true, tool: name, ids: { chatId }, count: files.length, files: (files as any[]).map((f) => ({ chatFileId: f.id, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.sizeBytes, uploadedAt: f.createdAt, mine: f.userId === userId })), message: files.length ? `${files.length} upload(s) on chat ${short(chatId)} — read_chat_upload {chatFileId} for the text.` : `No uploads on chat ${short(chatId)}.` });
    }
    case 'read_chat_upload': {
      const chatFileId = String(args?.chatFileId || '').trim();
      if (!chatFileId) return out({ ok: false, tool: name, reason: 'invalid', message: 'chatFileId is required (list_chat_uploads).' });
      const offsetRaw = args?.offset; const limitRaw = args?.limit;
      if (offsetRaw !== undefined && offsetRaw !== null && (!Number.isInteger(offsetRaw) || offsetRaw < 0)) return out({ ok: false, tool: name, reason: 'invalid', message: 'offset must be an integer ≥ 0.' });
      if (limitRaw !== undefined && limitRaw !== null && (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > CHAT_UPLOAD_TEXT_MAX)) return out({ ok: false, tool: name, reason: 'invalid', message: `limit must be an integer between 1 and ${CHAT_UPLOAD_TEXT_MAX}.` });
      const offset = typeof offsetRaw === 'number' ? offsetRaw : 0;
      const limit = typeof limitRaw === 'number' ? limitRaw : CHAT_UPLOAD_TEXT_MAX;
      const prisma = await db();
      const file = await prisma.chatFile.findUnique({ where: { id: chatFileId } }).catch(() => null);
      if (!file || !(await chatReadable(file.chatId, userId))) return out({ ok: false, tool: name, ids: { chatFileId }, reason: 'not_found', message: 'No chat upload you can read matches that id.' });
      const mime = String(file.mimeType || '').split(';')[0].trim().toLowerCase();
      const buffer = Buffer.from(file.data);
      const tx: any = await import('../text-extract');
      let text: string;
      try {
        if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') text = tx.extractPlainText(buffer);
        else if (mime === 'application/pdf') text = await tx.extractPdfUploadText(buffer, file.filename);
        else if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') text = await tx.extractDocxText(buffer);
        else if (mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mime === 'application/vnd.ms-excel') text = await tx.extractXlsxText(buffer);
        else return out({ ok: false, tool: name, ids: { chatFileId }, reason: 'no_text', message: `${file.filename} (${mime}) has no text rendering — images and binaries cannot be read as text.` });
      } catch (err: any) {
        return out({ ok: false, tool: name, ids: { chatFileId }, reason: 'unreadable', message: String(err?.message || err) });
      }
      const total = text.length;
      if (offset >= total && total > 0) return out({ ok: true, tool: name, ids: { chatFileId, chatId: file.chatId }, filename: file.filename, totalChars: total, offset, text: '', truncated: false, message: `offset ${offset} is past the end (${total} chars).` });
      const end = Math.min(offset + limit, total);
      return out({ ok: true, tool: name, ids: { chatFileId, chatId: file.chatId }, filename: file.filename, mimeType: mime, totalChars: total, offset, end, truncated: end < total, text: text.slice(offset, end), message: total ? `chars ${offset}–${end} of ${total}${end < total ? ' — page with offset/limit' : ''}.` : 'The file has no text.' });
    }
    case 'delete_chat_upload': {
      const chatFileId = String(args?.chatFileId || '').trim();
      if (!chatFileId) return out({ ok: false, tool: name, reason: 'invalid', message: 'chatFileId is required.' });
      const prisma = await db();
      const file = await prisma.chatFile.findUnique({ where: { id: chatFileId }, select: { id: true, userId: true, chatId: true, filename: true } }).catch(() => null);
      if (!file || file.userId !== userId) return out({ ok: false, tool: name, ids: { chatFileId }, reason: 'not_found', message: 'No chat upload of yours matches that id (only the uploader can delete).' });
      await prisma.chatFile.delete({ where: { id: file.id } });
      await audit(userId, 'chat_file.delete', { chatFileId, chatId: file.chatId, filename: file.filename, via: 'tool' });
      return out({ ok: true, tool: name, ids: { chatFileId, chatId: file.chatId }, message: `Deleted upload ${file.filename} from chat ${short(file.chatId)}.` });
    }
    case 'share_project': {
      const projectId = String(args?.projectId || '').trim();
      if (!projectId || typeof args?.enable !== 'boolean') return out({ ok: false, tool: name, reason: 'invalid', message: 'projectId and enable (boolean) are required.' });
      const project = await ownedProject(userId, projectId);
      if (!project) return out({ ok: false, tool: name, ids: { projectId }, reason: 'not_found', message: 'No project you own matches that id (sharing is owner-only).' });
      // Framework surface (ticket 9471d338): the platform's own project is
      // never a public share link (the REST seam refuses the same way).
      if (await isFrameworkRow(project)) {
        return out({ ok: false, tool: name, ids: { projectId }, reason: 'forbidden', message: await frameworkRefusal('share') });
      }
      const prisma = await db();
      if (args.enable) {
        const { randomBytes } = await import('crypto');
        const shareToken = project.shareToken ?? randomBytes(20).toString('hex');
        const updated = await prisma.crossModelProject.update({ where: { id: projectId }, data: { isPublic: true, shareToken } });
        const host = (process.env.FRONTEND_URL || '').split(',')[0] || 'https://digby.example.com';
        await audit(userId, 'project.share', { projectId, via: 'tool' });
        return out({ ok: true, tool: name, ids: { projectId }, shared: true, shareUrl: `${host}/shared/project/${updated.shareToken}`, message: `Project "${project.name}" is PUBLIC at ${host}/shared/project/${updated.shareToken} — share_project {enable:false} turns it off.` });
      }
      await prisma.crossModelProject.update({ where: { id: projectId }, data: { isPublic: false, shareToken: null } });
      await audit(userId, 'project.share.revoke', { projectId, via: 'tool' });
      return out({ ok: true, tool: name, ids: { projectId }, shared: false, message: `Project "${project.name}" is no longer public.` });
    }
    case 'add_project_member': {
      const projectId = String(args?.projectId || '').trim();
      const email = String(args?.email || '').trim().toLowerCase();
      const role = String(args?.role || 'viewer');
      if (!projectId || !email) return out({ ok: false, tool: name, reason: 'invalid', message: 'projectId and email are required.' });
      if (!MEMBER_ROLES.has(role)) return out({ ok: false, tool: name, reason: 'invalid', message: 'role must be viewer | editor | admin.' });
      const prisma = await db();
      const project = await prisma.crossModelProject.findUnique({ where: { id: projectId } }).catch(() => null);
      if (!project) return out({ ok: false, tool: name, ids: { projectId }, reason: 'not_found', message: 'Project not found.' });
      // Framework surface (ticket 9471d338): no membership mechanics (the
      // REST seam refuses the same way).
      if (await isFrameworkRow(project)) {
        return out({ ok: false, tool: name, ids: { projectId }, reason: 'forbidden', message: await frameworkRefusal('member') });
      }
      if (project.userId !== userId) {
        const me = await prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } }).catch(() => null);
        if (!me || me.role !== 'admin') return out({ ok: false, tool: name, ids: { projectId }, reason: 'forbidden', message: 'Only the project owner or an admin member can invite.' });
      }
      const invitee = await prisma.user.findUnique({ where: { email } }).catch(() => null) ?? await prisma.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } }).catch(() => null);
      if (!invitee) {
        // The sign-up host is THIS instance's (self-host setup hardening 2026-10-20) — "digby.example.com" was wrong on a self-host.
        const { instanceSiteLabel } = await import('./instance-setup');
        return out({ ok: false, tool: name, ids: { projectId }, reason: 'no_such_user', message: `No Digby account with email ${email} — they create one at ${instanceSiteLabel()} first.` });
      }
      if (invitee.id === project.userId) return out({ ok: false, tool: name, ids: { projectId }, reason: 'invalid', message: 'That is the project owner.' });
      const m = await prisma.projectMember.upsert({ where: { projectId_userId: { projectId, userId: invitee.id } }, create: { projectId, userId: invitee.id, role }, update: { role } });
      await audit(userId, 'project.member.add', { projectId, memberUserId: invitee.id, role, via: 'tool' });
      return out({ ok: true, tool: name, ids: { projectId, memberUserId: invitee.id }, role: m.role, message: `${email} is now ${m.role} on "${project.name}".` });
    }
    case 'remove_project_member': {
      const projectId = String(args?.projectId || '').trim();
      if (!projectId) return out({ ok: false, tool: name, reason: 'invalid', message: 'projectId is required.' });
      const prisma = await db();
      const project = await prisma.crossModelProject.findUnique({ where: { id: projectId } }).catch(() => null);
      if (!project) return out({ ok: false, tool: name, ids: { projectId }, reason: 'not_found', message: 'Project not found.' });
      // Framework surface (ticket 9471d338): no membership mechanics (the
      // REST seam refuses the same way).
      if (await isFrameworkRow(project)) {
        return out({ ok: false, tool: name, ids: { projectId }, reason: 'forbidden', message: await frameworkRefusal('member') });
      }
      let memberId = String(args?.userId || '').trim();
      if (!memberId && typeof args?.email === 'string' && args.email.trim()) {
        const u = await prisma.user.findFirst({ where: { email: { equals: args.email.trim().toLowerCase(), mode: 'insensitive' } }, select: { id: true } }).catch(() => null);
        memberId = u?.id ?? '';
      }
      if (!memberId) return out({ ok: false, tool: name, ids: { projectId }, reason: 'invalid', message: 'userId or a known email is required.' });
      if (project.userId !== userId && memberId !== userId) return out({ ok: false, tool: name, ids: { projectId }, reason: 'forbidden', message: 'Only the project owner can remove other members.' });
      const r = await prisma.projectMember.deleteMany({ where: { projectId, userId: memberId } });
      await audit(userId, 'project.member.remove', { projectId, memberUserId: memberId, via: 'tool' });
      return out({ ok: true, tool: name, ids: { projectId, memberUserId: memberId }, removed: r.count > 0, message: r.count > 0 ? `Removed ${short(memberId)} from "${project.name}".` : `${short(memberId)} was not a member of "${project.name}".` });
    }
    case 'resolve_feedback': {
      const id = String(args?.id || '').trim();
      if (!id) return out({ ok: false, tool: name, reason: 'invalid', message: 'id is required (list_feedback).' });
      const prisma = await db();
      const existing = await prisma.userFeatureRequest.findFirst({ where: { id, userId } }).catch(() => null);
      if (!existing) return out({ ok: false, tool: name, ids: { ticketId: id }, reason: 'not_found', message: 'No ticket you filed matches that id.' });
      if (existing.status === 'done') return out({ ok: true, tool: name, ids: { ticketId: id }, status: 'done', message: 'Already resolved.' });
      const updated = await prisma.userFeatureRequest.update({ where: { id }, data: { status: 'done', adminNote: existing.adminNote && !String(existing.adminNote).includes('kanban_task:') ? existing.adminNote : 'Marked as resolved by user.' } });
      await audit(userId, 'feedback.self_resolve', { ticketId: id, via: 'tool', chatId: ctx.sessionId });
      return out({ ok: true, tool: name, ids: { ticketId: id }, status: updated.status, message: `Ticket ${short(id)} "${existing.title}" marked resolved.` });
    }
    default:
      return out({ ok: false, tool: name, reason: 'unknown', message: `Unknown self-service tool ${name}.` });
  }
}
