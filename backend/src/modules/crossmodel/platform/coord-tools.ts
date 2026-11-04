/**
 * Coordination / workspace / file-handoff tools — agent capability gap audit,
 * tranche 3b (P1 #11, #12, #13-read, #16; 2026-09-24):
 *
 *   wait_for_chat        {chatId, timeoutSec?, until?}   READ (non-evidence): bounded block until a chat is idle / needs attention
 *   get_chat_instructions{chatId?}                       READ: a chat's standing instructions (full text)
 *   list_github_repos    {}                              READ: repos importable with the user's connected GitHub accounts
 *   list_session_files   {chatId, dir?}                  READ: one level of another session's worktree (owner or project member)
 *   read_session_file    {chatId, path}                  READ: one UTF-8 file of another session's worktree (same jail as the Files tab)
 *   sync_workspace       {projectId}                     MUTATING, non-consequential (owner): commit not-yet-committed knowledge docs
 *   stage_upload         {name, content|fileId|worktreePath} MUTATING, non-consequential: stage a 15-min upload blob → uploadId
 *   configure_workspace  {projectId, repoUrl?, ...}      CONSEQUENTIAL (card / autonomy grant / supervisor seat): make a folder repo-backed + provision
 *   import_repo          {repoUrl, name?, ...}           CONSEQUENTIAL: create a repo-backed coding project (mirror clones on first run)
 *
 * Every executor delegates to the same service functions the REST/UI twins
 * use. Import-light: heavy modules ride dynamic imports (config/env exits a
 * keyless jest at import).
 */

// chat-images is a leaf (no imports) — safe to import statically in an import-light module.
import { sniffMime } from '../coding/chat-images';

export const COORD_TOOL_NAMES = ['wait_for_chat', 'get_chat_instructions', 'list_github_repos', 'list_session_files', 'read_session_file', 'sync_workspace', 'stage_upload', 'configure_workspace', 'import_repo'] as const;
export type CoordToolName = (typeof COORD_TOOL_NAMES)[number];
export const isCoordTool = (name: string): name is CoordToolName => (COORD_TOOL_NAMES as readonly string[]).includes(name);

export const WAIT_FOR_CHAT_MAX_SEC = 600;
export const WAIT_FOR_CHAT_DEFAULT_SEC = 120;
export /**
 * Real mime for a staged file (peer verification 2026-09-25, ticket 390b6767 —
 * the owner's "why don't images from lanes show"): stage_upload stamped every
 * binary as application/octet-stream while `type` came from the extension, and
 * chat-files prefers attachment.mimeType, so a lane-delivered PNG 415'd on the
 * inline route. Magic bytes win (PNG/JPEG/GIF/WebP), then the extension when it
 * agrees with the content's binariness, else the old fallbacks.
 */
const STAGED_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain', '.svg': 'image/svg+xml',
  // Audio (ticket 6c050917): stage_upload stamped every audio binary as
  // application/octet-stream, so the persisted ChatFile 415'd on the inline
  // route and the chat UI could only offer a download. Audio is binary, so
  // the textual/agreement check below passes naturally.
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm',
};
export function stagedMime(filename: string, buf: Buffer | null, binary: boolean): string {
  if (buf) {
    const sniffed = sniffMime(buf.subarray(0, 16));
    if (sniffed) return sniffed;
  }
  const ext = (filename.match(/\.[A-Za-z0-9]+$/)?.[0] || '').toLowerCase();
  const byExt = STAGED_MIME_BY_EXT[ext];
  if (byExt) {
    const textual = /^(text\/|application\/json|image\/svg)/.test(byExt);
    if (textual === !binary) return byExt;
  }
  return binary ? 'application/octet-stream' : 'text/plain';
}

const STAGE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export const COORD_TOOL_SCHEMA = [
  { type: 'function' as const, function: { name: 'wait_for_chat', description: "BLOCK (bounded) until another chat's run finishes — ONE call instead of polling get_chat_status across tool rounds or arming a ≥15-minute one-shot. until='idle' (default) returns when the chat has no running or queued run; until='attention' returns as soon as the chat parks on a question/approval (or goes idle). timeoutSec ≤ 600 (default 120); re-call to keep waiting — the wait does not count against your run deadline. Returns outcome idle | attention | timeout plus the chat's live state. Never waits on THIS chat. Owner or project member.", parameters: { type: 'object', properties: { chatId: { type: 'string' }, timeoutSec: { type: 'number', description: '5–600, default 120.' }, until: { type: 'string', enum: ['idle', 'attention'] } }, required: ['chatId'] } } },
  { type: 'function' as const, function: { name: 'get_chat_instructions', description: "Read a chat's STANDING INSTRUCTIONS (its per-chat systemPrompt — the full text, not a preview). chatId omitted = this chat. Use it before set_chat_instructions on a lane (to extend rather than overwrite) and to explain to the user what a chat has been told to do. Supervisor chats report platform-managed (no editable text). Owner or project member; read-only.", parameters: { type: 'object', properties: { chatId: { type: 'string' } } } } },
  { type: 'function' as const, function: { name: 'list_github_repos', description: "List the GitHub repositories the user's CONNECTED GitHub account(s) can import (owner / collaborator / org member; up to 100 per account, newest first): fullName, cloneUrl, defaultBranch, private, githubLabel (which connected account). connected:false when no GitHub account is linked — then say so and stop; never invent a repo. Read-only (one GitHub API call per account).", parameters: { type: 'object', properties: {} } } },
  { type: 'function' as const, function: { name: 'list_session_files', description: "List ONE directory level of another coding session's worktree ({name, type, size}) — the same tree the Files tab shows, served from disk, the shared snapshot or a live cross-box read. dir omitted = the root. .git and node_modules are never listed. Owner or project member. Use it with read_session_file to inspect a child's work without asking it to paste content.", parameters: { type: 'object', properties: { chatId: { type: 'string' }, dir: { type: 'string', description: 'Worktree-relative directory (forward slashes).' } }, required: ['chatId'] } } },
  { type: 'function' as const, function: { name: 'read_session_file', description: "Read ONE UTF-8 text file (≤ 256 KB) from another coding session's worktree by worktree-relative path — the same path jail, size and binary guards as the Files tab (disk → shared snapshot → live cross-box read). Binary / oversized files are refused with the reason. Owner or project member. For the CURRENT session use read_file.", parameters: { type: 'object', properties: { chatId: { type: 'string' }, path: { type: 'string' } }, required: ['chatId', 'path'] } } },
  { type: 'function' as const, function: { name: 'sync_workspace', description: "Commit a repo-backed project's not-yet-committed knowledge documents to its workspace (local projects → the default branch; github/git projects → the local-only digby/knowledge branch). Owner-only; idempotent; returns {committed, skipped}. Not consequential (nothing leaves the box).", parameters: { type: 'object', properties: { projectId: { type: 'string' } }, required: ['projectId'] } } },
  { type: 'function' as const, function: { name: 'stage_upload', description: "Stage a file from content YOU hold as an upload → uploadId, so send_chat_message {uploadIds:[id]} can hand it to another chat (a child's report to its parent, a CSV to a lane, a file to the user's chat). Exactly one source: content (text ≤ 8 MB), fileId (a generated file of yours — the id create_document returned), documentId (a knowledge-base document you can read — its extracted text, rebuilt from the index), or worktreePath (a file in THIS session's worktree). The blob lives 15 minutes (a queued send extends it). Owner-scoped; not consequential.", parameters: { type: 'object', properties: { name: { type: 'string', description: 'Filename with extension (basename only).' }, content: { type: 'string' }, fileId: { type: 'string' }, documentId: { type: 'string' }, worktreePath: { type: 'string' } }, required: ['name'] } } },
  // Ticket 23f453de: the projectId parameter accepts the same reference forms
  // start_coding_session does (exact id → chat id in the project → EXACT name →
  // unique ≥8-char prefix) — resolved at the seam via canonicalizeProjectReference;
  // an unresolvable reference refuses with a did-you-mean. Documented on the
  // PARAMETER (description budget: the top-level row is 800).
  { type: 'function' as const, function: { name: 'configure_workspace', description: "Make a project (folder) REPO-BACKED and provision its mirror: repoUrl (https git URL; omit for a Digby-owned local repo), provider github|git|local (default: github when repoUrl is set, else local), defaultBranch (default main), githubLabel (which connected GitHub account to use — list_github_repos shows labels). It clones with the user's GitHub credential and spends disk/compute. On the user's OWN turn it executes at once (say it is being set up, never that it waits on a click); from a machine run it stages a confirmation unless this chat holds an autonomy grant (supervisor seats do). Owner-only; a DIFFERENT configured target is refused (409); the same target is idempotent, and a same-target or label-only call carrying githubLabel re-pins the stored label (absent label never clears).", parameters: { type: 'object', properties: { projectId: { type: 'string', description: "The project's id verbatim from list_projects, its EXACT name, a chat id inside it, or a unique ≥8-char id prefix — never reconstruct or abbreviate an id." }, repoUrl: { type: 'string' }, provider: { type: 'string', enum: ['github', 'git', 'local'] }, defaultBranch: { type: 'string' }, githubLabel: { type: 'string' } }, required: ['projectId'] } } },
  { type: 'function' as const, function: { name: 'import_repo', description: "Create a NEW repo-backed coding project from a GitHub/git URL (https only; private/loopback hosts refused): name (default: the repo name), defaultBranch (default main), parentId (file it under a folder), githubLabel (which connected GitHub account). The mirror is cloned with the user's credential when the first session starts (start_coding_session {projectId}). On the user's OWN turn it executes at once (their ask is the authorization — say the import has started, never that it is waiting on a click); from a machine run it stages a confirmation unless this chat holds an autonomy grant for it (supervisor seats do).", parameters: { type: 'object', properties: { repoUrl: { type: 'string' }, name: { type: 'string' }, defaultBranch: { type: 'string' }, parentId: { type: 'string' }, githubLabel: { type: 'string' } }, required: ['repoUrl'] } } },
];

type Ctx = { sessionId: string; userId: string; userTurnAt?: Date | null; worktree?: string };
type Deps = { platform: any };
const out = (o: Record<string, unknown>): string => JSON.stringify(o, null, 1);
const short = (s: string) => String(s || '').slice(0, 8);
async function db(): Promise<any> { return (await import('../../../config/database')).default; }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function resolveChat(platform: any, ctx: Ctx, raw: string): Promise<string> {
  if (!raw || raw === ctx.sessionId) return raw || ctx.sessionId;
  return typeof platform?.resolveOwnedChatIdPrefix === 'function' ? platform.resolveOwnedChatIdPrefix(ctx.userId, raw).catch(() => raw) : raw;
}
async function chatReadable(chatId: string, userId: string): Promise<boolean> {
  const cm: any = (await import('../crossmodel.service')).default;
  const access = await cm.getChatAccess(chatId, userId).catch(() => ({ access: 'none', exists: false }));
  return !!access && access.access !== 'none';
}
function safeBasename(name: string): string | null {
  const n = String(name || '').trim().replace(/\\/g, '/');
  const base = n.split('/').pop() || '';
  if (!base || base === '.' || base === '..' || base.length > 200 || base.includes('\0')) return null;
  return base;
}

export async function executeCoordTool(ctx: Ctx, name: CoordToolName, args: any, deps: Deps): Promise<string> {
  const { platform } = deps;
  const userId = ctx.userId;
  switch (name) {
    case 'wait_for_chat': {
      const raw = String(args?.chatId || '').trim();
      if (!raw) return out({ ok: false, tool: name, reason: 'invalid', message: 'chatId is required.' });
      const chatId = await resolveChat(platform, ctx, raw);
      if (chatId === ctx.sessionId) return out({ ok: false, tool: name, reason: 'self', message: 'wait_for_chat cannot wait on the chat it runs in (that never returns) — name another chat.' });
      if (!(await chatReadable(chatId, userId))) return out({ ok: false, tool: name, reason: 'not_found', message: 'No chat you can read matches that id.' });
      const until = String(args?.until || 'idle') === 'attention' ? 'attention' : 'idle';
      const timeoutSec = Math.min(WAIT_FOR_CHAT_MAX_SEC, Math.max(5, Number(args?.timeoutSec) || WAIT_FOR_CHAT_DEFAULT_SEC));
      const pollMs = Math.max(50, Number(process.env.WAIT_FOR_CHAT_POLL_MS) || 5_000);
      const { isChatBusy } = await import('../chat-agent/chat-busy');
      const { getSessionAttention } = await import('../coding/session-run-lock');
      const t0 = Date.now();
      let polls = 0;
      for (;;) {
        polls++;
        const running = await isChatBusy(chatId).catch(() => false);
        const att = await getSessionAttention(chatId).catch(() => ({ approvals: [] as string[], questions: [] as string[] }));
        const awaitingInput = att.approvals.length > 0 || att.questions.length > 0;
        const waitedSec = Math.round((Date.now() - t0) / 1000);
        const state = { running, attention: { awaitingInput, pendingApprovals: att.approvals, pendingQuestions: att.questions } };
        if (until === 'attention' && awaitingInput) return out({ ok: true, tool: name, ids: { chatId }, outcome: 'attention', waitedSec, polls, ...state, message: `Chat ${short(chatId)} is waiting on input (${att.questions.length} question(s), ${att.approvals.length} approval(s)) — answer_chat_question / approve_request, or get_chat_messages for the text.` });
        if (!running) return out({ ok: true, tool: name, ids: { chatId }, outcome: 'idle', waitedSec, polls, ...state, message: `Chat ${short(chatId)} is idle${awaitingInput ? ' but parked on input' : ''} — get_chat_messages / get_run_receipts for what it produced.` });
        const remainingMs = timeoutSec * 1000 - (Date.now() - t0);
        if (remainingMs <= 0) return out({ ok: true, tool: name, ids: { chatId }, outcome: 'timeout', waitedSec, polls, ...state, message: `Chat ${short(chatId)} is still running after ${timeoutSec}s — call wait_for_chat again to keep waiting, or continue with other work.` });
        await sleep(Math.min(pollMs, remainingMs));
      }
    }
    case 'get_chat_instructions': {
      const chatId = await resolveChat(platform, ctx, String(args?.chatId || '').trim());
      if (!(await chatReadable(chatId, userId))) return out({ ok: false, tool: name, reason: 'not_found', message: 'No chat you can read matches that id.' });
      const prisma = await db();
      const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { id: true, title: true, systemPrompt: true, isSupervisor: true, isProjectSupervisor: true } }).catch(() => null);
      if (!chat) return out({ ok: false, tool: name, reason: 'not_found', message: 'No chat you can read matches that id.' });
      const managed = !!chat.isSupervisor || !!chat.isProjectSupervisor;
      const text = typeof chat.systemPrompt === 'string' && chat.systemPrompt.trim() ? chat.systemPrompt : null;
      return out({ ok: true, tool: name, ids: { chatId: chat.id }, title: chat.title ?? null, supervisorManaged: managed, instructions: managed ? null : text, chars: text ? text.length : 0, message: managed ? `Chat ${short(chat.id)} is a supervisor chat — its prompt is platform-managed and cannot be edited.` : text ? `Chat ${short(chat.id)} carries ${text.length} chars of standing instructions.` : `Chat ${short(chat.id)} has no standing instructions.` });
    }
    case 'list_github_repos': {
      const { getAllValidTokens } = await import('../github/token-manager');
      const accounts = await getAllValidTokens(userId).catch(() => [] as Array<{ token: string; label: string; username?: string }>);
      if (!accounts.length) return out({ ok: true, tool: name, connected: false, repos: [], message: 'No GitHub account is connected — the user links one under Account → Integrations; import_repo also accepts any public https git URL without one.' });
      const axios = (await import('axios')).default;
      const byName = new Map<string, any>();
      const errors: string[] = [];
      for (const acct of accounts) {
        try {
          const resp = await axios.get('https://api.github.com/user/repos', {
            headers: { Authorization: `Bearer ${acct.token}`, Accept: 'application/vnd.github+json' },
            params: { per_page: 100, sort: 'updated', affiliation: 'owner,collaborator,organization_member' },
            timeout: 15_000,
          });
          for (const r of (resp.data as any[]) || []) {
            if (!byName.has(r.full_name)) byName.set(r.full_name, { fullName: r.full_name, name: r.name, cloneUrl: r.clone_url, defaultBranch: r.default_branch || 'main', private: !!r.private, updatedAt: r.updated_at, githubLabel: acct.label });
          }
        } catch (err: any) {
          errors.push(`${acct.label}: ${String(err?.response?.status || err?.message || err)}`);
        }
      }
      const repos = [...byName.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return out({ ok: true, tool: name, connected: true, accounts: accounts.map((a) => ({ label: a.label, username: a.username ?? null })), count: repos.length, repos, ...(errors.length ? { errors } : {}), message: `${repos.length} importable repo(s) across ${accounts.length} connected account(s).` });
    }
    case 'list_session_files':
    case 'read_session_file': {
      const raw = String(args?.chatId || '').trim();
      if (!raw) return out({ ok: false, tool: name, reason: 'invalid', message: 'chatId is required.' });
      const chatId = await resolveChat(platform, ctx, raw);
      const wf: any = await import('../coding/worktree-files');
      const resolved = await wf.resolveWorktreeForUser(chatId, userId, 'read');
      if (!resolved.ok) return out({ ok: false, tool: name, ids: { chatId }, reason: resolved.status === 404 ? 'not_found' : 'refused', message: resolved.error });
      if (name === 'list_session_files') {
        const r = await wf.listWorktreeTreeCore(resolved.ctx, String(args?.dir || ''), false);
        if (r.status !== 200) return out({ ok: false, tool: name, ids: { chatId }, reason: r.status === 404 ? 'not_found' : 'refused', status: r.status, message: r.body?.error || 'listing failed' });
        return out({ ok: true, tool: name, ids: { chatId }, ...r.body, source: resolved.ctx.disk ? 'disk' : 'snapshot' });
      }
      const rel = String(args?.path || '').trim();
      if (!rel) return out({ ok: false, tool: name, reason: 'invalid', message: 'path is required.' });
      const r = await wf.readWorktreeFileCore(resolved.ctx, rel);
      if (r.status !== 200) return out({ ok: false, tool: name, ids: { chatId }, reason: r.status === 404 ? 'not_found' : r.status === 413 ? 'too_large' : r.status === 415 ? 'binary' : 'refused', status: r.status, message: r.body?.error || 'read failed' });
      return out({ ok: true, tool: name, ids: { chatId }, path: r.body.path, content: r.body.content, source: r.body.live ? 'live' : r.body.snapshot ? 'snapshot' : 'disk' });
    }
    case 'sync_workspace': {
      const projectId = String(args?.projectId || '').trim();
      if (!projectId) return out({ ok: false, tool: name, reason: 'invalid', message: 'projectId is required.' });
      // Ticket 23f453de (same seam): resolve the reference with the shared
      // canonicalizer before the exact-id lookup — an abbreviated id or a
      // name reference must not surface as a bare "not found" for a project
      // the caller can see. Fail-open on a broken resolver (absent, throws,
      // returns undefined); a resolved null is a genuine refusal.
      let targetProjectId = projectId;
      if (typeof platform?.canonicalizeProjectReference === 'function') {
        let canon: { id: string } | null | undefined;
        try {
          canon = await platform.canonicalizeProjectReference(userId, projectId);
        } catch { canon = undefined; }
        if (canon && canon.id) {
          targetProjectId = canon.id;
        } else if (canon === null) {
          const suggestions: Array<{ id: string; name: string }> =
            await (platform?.suggestProjectsByIdPrefix?.({ userId, projectIdPrefix: projectId }) ?? Promise.resolve([])).catch(() => []);
          const hint = suggestions.length > 0
            ? ` Did you mean: ${suggestions.map((s) => `${s.id} ("${s.name}")`).join('; ')}?`
            : '';
          return out({ ok: false, tool: name, ids: { projectId }, reason: 'not_found', message: `No project "${projectId}" is visible to you (wrong id, or a project you can see but do not own — sync_workspace is owner-only).${hint} Re-call with the EXACT projectId from list_projects (or its EXACT name, a chat id inside it, or a unique ≥8-char id prefix).` });
        }
      }
      const prisma = await db();
      const project = await prisma.crossModelProject.findFirst({ where: { id: targetProjectId, userId }, select: { id: true, name: true, repoProvider: true } }).catch(() => null);
      // Review finding 1 (23f453de): the fail-open fallback must NAME the id
      // too — the same never-a-bare-not-found rule as every other branch.
      if (!project) return out({ ok: false, tool: name, ids: { projectId }, reason: 'not_found', message: `No project you own matches that id (projectId: "${projectId}"; sync is owner-only).` });
      if (!project.repoProvider) return out({ ok: false, tool: name, ids: { projectId: targetProjectId }, reason: 'no_workspace', message: `Project "${project.name}" has no workspace yet — configure_workspace first.` });
      const svc: any = await import('../coding/project-workspace.service');
      try {
        const result = await svc.syncKnowledgeToRepo(targetProjectId);
        return out({ ok: true, tool: name, ids: { projectId: targetProjectId }, ...result, message: `Project "${project.name}": ${result.committed} document(s) committed, ${result.skipped} skipped.` });
      } catch (err: any) {
        return out({ ok: false, tool: name, ids: { projectId: targetProjectId }, reason: 'error', message: String(err?.message || err) });
      }
    }
    case 'stage_upload': {
      const filename = safeBasename(args?.name);
      if (!filename) return out({ ok: false, tool: name, reason: 'invalid', message: 'name must be a plain filename with an extension (no directories).' });
      const sources = ['content', 'fileId', 'documentId', 'worktreePath'].filter((k) => typeof args?.[k] === 'string' && args[k].length > 0);
      if (sources.length !== 1) return out({ ok: false, tool: name, reason: 'invalid', message: 'Pass exactly ONE of content, fileId, documentId or worktreePath.' });
      const { randomUUID } = await import('crypto');
      const up: any = await import('../upload.controller');
      let attachment: any;
      let bytes = 0;
      if (sources[0] === 'content') {
        const content = String(args.content);
        bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > STAGE_UPLOAD_MAX_BYTES) return out({ ok: false, tool: name, reason: 'too_large', message: `content is ${bytes} bytes — the limit is ${STAGE_UPLOAD_MAX_BYTES}.` });
        attachment = { type: 'document', filename, mimeType: stagedMime(filename, null, false), extractedText: content, base64: Buffer.from(content, 'utf8').toString('base64') };
      } else if (sources[0] === 'documentId') {
        // Knowledge document → its extracted text, rebuilt from the chunk index
        // (raw bytes are never persisted; the same rebuild syncKnowledgeToRepo uses).
        const prisma = await db();
        const doc = await prisma.projectDocument.findUnique({ where: { id: String(args.documentId) }, select: { id: true, name: true, projectId: true, userId: true, status: true } }).catch(() => null);
        if (!doc) return out({ ok: false, tool: name, reason: 'not_found', message: 'No knowledge document matches that documentId (list_knowledge_documents).' });
        const access = doc.projectId ? await platform.getProjectAccess(doc.projectId, userId).catch(() => null) : null;
        if (!access && doc.userId !== userId) return out({ ok: false, tool: name, reason: 'not_found', message: 'No knowledge document you can read matches that documentId.' });
        const chunks: Array<{ content: string }> = await prisma.projectChunk.findMany({ where: { documentId: doc.id }, orderBy: { chunkIndex: 'asc' }, select: { content: true } }).catch(() => []);
        const text = chunks.map((c) => c.content).join('\n\n');
        if (!text.trim()) return out({ ok: false, tool: name, reason: 'no_text', message: `Document "${doc.name}" has no indexed text yet (status ${doc.status}) — nothing to stage.` });
        bytes = Buffer.byteLength(text, 'utf8');
        if (bytes > STAGE_UPLOAD_MAX_BYTES) return out({ ok: false, tool: name, reason: 'too_large', message: `The document text is ${bytes} bytes — the limit is ${STAGE_UPLOAD_MAX_BYTES}.` });
        attachment = { type: 'document', filename, mimeType: stagedMime(filename, null, false), extractedText: text, base64: Buffer.from(text, 'utf8').toString('base64') };
      } else if (sources[0] === 'fileId') {
        const prisma = await db();
        const row = await prisma.generatedFile.findFirst({ where: { id: String(args.fileId), userId }, select: { id: true, filename: true, mimeType: true, size: true, data: true, textContent: true } }).catch(() => null);
        if (!row) return out({ ok: false, tool: name, reason: 'not_found', message: 'No generated file of yours matches that fileId.' });
        bytes = Number(row.size) || Buffer.from(String(row.data || ''), 'base64').length;
        if (bytes > STAGE_UPLOAD_MAX_BYTES) return out({ ok: false, tool: name, reason: 'too_large', message: `The file is ${bytes} bytes — the limit is ${STAGE_UPLOAD_MAX_BYTES}.` });
        const isImage = /^image\//i.test(String(row.mimeType || ''));
        const isPdf = /pdf/i.test(String(row.mimeType || ''));
        attachment = { type: isImage ? 'image' : isPdf ? 'pdf' : 'document', filename, mimeType: row.mimeType || 'application/octet-stream', base64: row.data, ...(row.textContent ? { extractedText: row.textContent } : {}) };
      } else {
        const root = String(ctx.worktree || '');
        if (!root) return out({ ok: false, tool: name, reason: 'no_worktree', message: 'This run has no worktree — use content or fileId.' });
        const wf: any = await import('../coding/worktree-files');
        const fs = await import('fs/promises');
        try {
          const { abs, rel } = await wf.resolveSafeWorktreePath(root, String(args.worktreePath));
          const st = await fs.stat(abs);
          if (!st.isFile()) return out({ ok: false, tool: name, reason: 'invalid', message: `${rel} is not a regular file.` });
          if (st.size > STAGE_UPLOAD_MAX_BYTES) return out({ ok: false, tool: name, reason: 'too_large', message: `${rel} is ${st.size} bytes — the limit is ${STAGE_UPLOAD_MAX_BYTES}.` });
          const buf = await fs.readFile(abs);
          bytes = buf.length;
          const binary = wf.isProbablyBinary(buf.subarray(0, wf.SNIFF_BYTES));
          const mimeType = stagedMime(filename, buf, binary);
          attachment = { type: /^image\/(png|jpe?g|gif|webp)$/i.test(mimeType) || /\.(png|jpe?g|gif|webp)$/i.test(filename) ? 'image' : /pdf$/i.test(mimeType) || /\.pdf$/i.test(filename) ? 'pdf' : /^audio\//i.test(mimeType) || /\.(wav|mp3|m4a|aac|ogg|oga|opus|flac|webm)$/i.test(filename) ? 'audio' : 'document', filename, mimeType, base64: buf.toString('base64'), ...(binary ? {} : { extractedText: buf.toString('utf8') }) };
        } catch (err: any) {
          return out({ ok: false, tool: name, reason: 'refused', message: String(err?.message || err) });
        }
      }
      const uploadId = randomUUID();
      attachment.uploadId = uploadId;
      attachment.ownerUserId = userId;
      await up.saveAttachment(uploadId, attachment);
      return out({ ok: true, tool: name, ids: { uploadId }, filename, bytes, type: attachment.type, expiresInMinutes: 15, message: `Staged ${filename} (${bytes} bytes) as upload ${uploadId} — pass it in send_chat_message {uploadIds:["${uploadId}"]} within 15 minutes.` });
    }
    case 'configure_workspace': {
      const projectId = String(args?.projectId || '').trim();
      if (!projectId) return out({ ok: false, tool: name, reason: 'invalid', message: 'projectId is required.' });
      const repoUrl = typeof args?.repoUrl === 'string' && args.repoUrl.trim() ? args.repoUrl.trim() : undefined;
      const provider = ['github', 'git', 'local'].includes(String(args?.provider)) ? String(args.provider) as 'github' | 'git' | 'local' : undefined;
      const defaultBranch = typeof args?.defaultBranch === 'string' && args.defaultBranch.trim() ? args.defaultBranch.trim() : undefined;
      const githubLabel = typeof args?.githubLabel === 'string' && args.githubLabel.trim() ? args.githubLabel.trim() : null;
      const svc: any = await import('../coding/project-workspace.service');
      // Ticket 23f453de: the reference is resolved with the SAME canonicalizer
      // start_coding_session uses (exact id → chat id in the project → EXACT
      // name → unique ≥8-char id prefix, never widening access) instead of
      // passing it raw into an exact-id-only lookup. A re-pin on the
      // ericfoundation.com project died ~1h on the raw shape: an abbreviated
      // id or a name reference surfaced as a bare "Project not found" for a
      // project list_projects returns, pushing a needless owner reconnect.
      // Fail-open when the resolver is absent, errors or returns a broken
      // value (older partial mocks) — the service's named 404 then speaks.
      // A resolved null is a GENUINE unresolvable reference: refuse with the
      // did-you-mean instead of provisioning a phantom.
      let targetProjectId = projectId;
      if (typeof platform?.canonicalizeProjectReference === 'function') {
        let canon: { id: string } | null | undefined;
        try {
          canon = await platform.canonicalizeProjectReference(userId, projectId);
        } catch { canon = undefined; }
        if (canon && canon.id) {
          targetProjectId = canon.id;
        } else if (canon === null) {
          const suggestions: Array<{ id: string; name: string }> =
            await (platform?.suggestProjectsByIdPrefix?.({ userId, projectIdPrefix: projectId }) ?? Promise.resolve([])).catch(() => []);
          const hint = suggestions.length > 0
            ? ` Did you mean: ${suggestions.map((s) => `${s.id} ("${s.name}")`).join('; ')}?`
            : '';
          return out({ ok: false, tool: name, ids: { projectId }, reason: 'not_found', message: `Cannot configure workspace: no project "${projectId}" is visible to you (wrong id, or a project you can see but do not own — configure_workspace is owner-only).${hint} Re-call configure_workspace with the EXACT projectId copied verbatim from list_projects (or its EXACT name, a chat id inside it, or a unique ≥8-char id prefix); never reconstruct or abbreviate an id. Nothing was staged or re-pinned.` });
        }
      }
      if (repoUrl) {
        const bad = svc.validateRepoUrl(repoUrl);
        if (bad) return out({ ok: false, tool: name, ids: { projectId }, reason: 'invalid', message: bad });
      }
      try {
        await svc.configureWorkspace(targetProjectId, userId, { repoUrl, provider, defaultBranch, githubLabel });
        const { getValidToken } = await import('../github/token-manager');
        await svc.ensureProvisioned(targetProjectId, () => getValidToken(userId, githubLabel || undefined));
        const ws = await svc.getWorkspace(targetProjectId);
        return out({ ok: true, tool: name, ids: { projectId: targetProjectId }, workspace: ws, message: `Project ${short(targetProjectId)} is now ${ws?.provider ?? provider ?? 'local'}-backed${ws?.repoUrl ? ` (${ws.repoUrl})` : ''} and provisioned — start_coding_session {projectId} runs against it.` });
      } catch (err: any) {
        const status = Number(err?.status ?? err?.statusCode ?? 0);
        return out({ ok: false, tool: name, ids: { projectId: targetProjectId }, reason: status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'error', message: String(err?.message || err) });
      }
    }
    case 'import_repo': {
      const repoUrl = String(args?.repoUrl || '').trim();
      if (!repoUrl) return out({ ok: false, tool: name, reason: 'invalid', message: 'repoUrl is required.' });
      const svc: any = await import('../coding/project-workspace.service');
      const bad = svc.validateRepoUrl(repoUrl);
      if (bad) return out({ ok: false, tool: name, reason: 'invalid', message: bad });
      const derived = repoUrl.replace(/\/+$/, '').split('/').pop()!.replace(/\.git$/i, '');
      const projName = (typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : derived).slice(0, 200);
      const defaultBranch = typeof args?.defaultBranch === 'string' && args.defaultBranch.trim() ? args.defaultBranch.trim() : 'main';
      const githubLabel = typeof args?.githubLabel === 'string' && args.githubLabel.trim() ? args.githubLabel.trim() : null;
      const parentId = typeof args?.parentId === 'string' && args.parentId.trim() ? args.parentId.trim() : null;
      const { createCodingProject } = await import('../coding/coding-data.service');
      let project: any;
      try {
        project = await createCodingProject({ userId, name: projName, repoUrl, defaultBranch, provider: /github\.com/i.test(repoUrl) ? 'github' : 'git', githubLabel });
      } catch (err: any) {
        return out({ ok: false, tool: name, reason: 'error', message: String(err?.message || err) });
      }
      // e1cca01d write-seam guard: name a dead label pin AT import time (the
      // 2026-10-18 canlegal-bench class — the bad pin surfaced 5 h later as a
      // 73-row warn hot-loop). Non-blocking: the f121 fallback keeps writes
      // working whatever the pin says. Shares the ONE implementation with the
      // configure_workspace seam (adversarial review finding 7 — no drift).
      if (typeof githubLabel === 'string' && githubLabel.length > 0) {
        try { await svc.warnIfPinnedLabelMissing(userId, project.id); } catch { /* observability only */ }
      }
      let filed: string | null = null;
      if (parentId && typeof platform?.moveFolder === 'function') {
        try { await platform.moveFolder({ userId, folderId: project.id, newParentId: parentId }); filed = parentId; } catch (err: any) { filed = null; return out({ ok: true, tool: name, ids: { projectId: project.id }, project: { id: project.id, name: projName, repoUrl, defaultBranch }, warning: `created, but filing under ${short(parentId)} failed: ${String(err?.message || err)}`, message: `Project "${projName}" (${short(project.id)}) imported from ${repoUrl}; the mirror clones on the first session start — start_coding_session {projectId:"${project.id}"}.` }); }
      }
      return out({ ok: true, tool: name, ids: { projectId: project.id }, project: { id: project.id, name: projName, repoUrl, defaultBranch, parentId: filed }, message: `Project "${projName}" (${short(project.id)}) imported from ${repoUrl}; the mirror clones with the user's credential on the first session start — start_coding_session {projectId:"${project.id}"}.` });
    }
    default:
      return out({ ok: false, tool: name, reason: 'unknown', message: `Unknown coordination tool ${name}.` });
  }
}
