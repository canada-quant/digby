import { Router } from 'express';
import { rejectChild } from '../../middleware/auth';
import controller from './documents.controller';

const router = Router();

// Authenticated by the app-level guard (app.ts) — no router.use(authenticate).
router.use(rejectChild); // Digby Kids: adult workspace — child tokens are rejected

// Upload file to project
router.post(
  '/projects/:id/documents',
  controller.knowledgeUploadMiddleware,
  controller.uploadDocumentToProject
);

// Add URL to project knowledge base
router.post('/projects/:id/documents/url', controller.addUrlToProject);

// Add a Gmail attachment to project knowledge base (ticket 99145890) —
// { messageId, filename, label? }; dedup by messageId+filename.
router.post('/projects/:id/documents/gmail-attachment', controller.addGmailAttachmentToProject);

// Get document status (for polling)
router.get('/documents/:docId/status', controller.getDocumentStatus);

// Delete document + all chunks
router.delete('/documents/:docId', controller.deleteDocument);

export default router;
