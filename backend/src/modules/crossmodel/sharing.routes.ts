import { Router } from 'express';
import { rejectChild } from '../../middleware/auth';
import controller from './sharing.controller';

const router = Router();

// NOTE: the public /shared/chat/:token route lives in public-share.routes.ts,
// mounted before the app-level authenticate guard, which would otherwise 401
// the request before it reaches the unauthenticated handler.

// Authenticated by the app-level guard (app.ts) — no router.use(authenticate).
router.use(rejectChild); // Digby Kids: adult workspace — child tokens are rejected

// Global files list (all documents across all projects)
router.get('/files', controller.listAllFiles);

// Chat share links
router.get('/chats/:id/share', controller.getChatShareStatus);
router.post('/chats/:id/share', controller.createChatShareLink);
router.delete('/chats/:id/share', controller.revokeChatShareLink);

export default router;
