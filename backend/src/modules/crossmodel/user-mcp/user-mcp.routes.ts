/**
 * User-added MCP servers (ticket e294f9a4) — routes, mounted under
 * /api/crossmodel/mcp-servers by crossmodel.routes.ts (behind THE app-level
 * auth guard — no router.use(authenticate) here; per-route rejectChild:
 * Digby Kids never get user integrations).
 *
 *   GET    /mcp-servers            — the caller's servers (health + tools)
 *   GET    /mcp-servers/templates  — quick-start catalog
 *   POST   /mcp-servers            — add (+ immediate probe)
 *   POST   /mcp-servers/test       — probe a draft (nothing stored)
 *   PATCH  /mcp-servers/:id        — update (authValue '' clears; enable / tools / machine writes)
 *   POST   /mcp-servers/:id/test   — live probe of a saved server
 *   DELETE /mcp-servers/:id
 *
 * Kill switch USER_MCP_DISABLED=1 ⇒ every route answers 404.
 */

import { Router } from 'express';
import { rejectChild } from '../../../middleware/auth';
import { validate } from '../../../middleware/validate';
import controller from './user-mcp.controller';
import { createUserMcpServerSchema, updateUserMcpServerSchema, testDraftUserMcpServerSchema, userMcpServerIdSchema } from './user-mcp.validation';

const router = Router();

router.get('/', rejectChild, controller.list.bind(controller));
router.get('/templates', rejectChild, controller.templates.bind(controller));
router.post('/', rejectChild, validate(createUserMcpServerSchema), controller.create.bind(controller));
router.post('/test', rejectChild, validate(testDraftUserMcpServerSchema), controller.testDraft.bind(controller));
router.patch('/:id', rejectChild, validate(updateUserMcpServerSchema), controller.update.bind(controller));
router.post('/:id/test', rejectChild, validate(userMcpServerIdSchema), controller.test.bind(controller));
router.delete('/:id', rejectChild, validate(userMcpServerIdSchema), controller.remove.bind(controller));

export default router;
