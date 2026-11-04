/**
 * Persistent per-chat files — router (2026-08-25).
 *
 * AUTH IS APP-LEVEL: like crossmodel.routes.ts, this router has NO internal
 * `authenticate` — app.ts's single guard covers it. Authorization is PER-ROUTE
 * in the controller (read access to the parent chat — owner or any project
 * member, same gate as reading the chat's messages; non-members get 404).
 * ChatFile is for UPLOADS ONLY — agent-generated documents stay on the
 * separate generated-files routes.
 */
import { Router } from 'express';
import * as controller from './chat-files.controller';

const router = Router();

// Metadata list for one chat (newest first) — read access to the chat.
router.get('/chats/:chatId/files', controller.listChatFiles);

// User-wide metadata list (the global Files page's Chat uploads section).
// NOTE: a bare '/files' would collide with sharing.routes.ts's listAllFiles
// (mounted earlier in app.ts) — hence '/chat-uploads'.
router.get('/chat-uploads', controller.listUserChatFiles);

// Byte serving — the same chat read-access gate as the list.
router.get('/files/:fileId/download', controller.downloadChatFile);
router.get('/files/:fileId/inline', controller.inlineChatFile);
// Extracted TEXT for in-panel document preview (docx/xlsx/pdf/txt) — TEXT,
// not bytes: the /inline isInlineSafe byte allowlist (stored-XSS guard) stays
// untouched. Same chat read-access gate.
router.get('/files/:fileId/preview-text', controller.previewTextChatFile);

// Delete one upload — uploader only (non-leaking 404 otherwise).
router.delete('/files/:fileId', controller.deleteChatFile);

export default router;
