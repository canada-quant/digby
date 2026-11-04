import { Request, Response } from 'express';
import multer from 'multer';
import { extractTextFromBuffer, processDocument } from './ingestion.service';
import { webSearchMissingOnInstance } from './platform/instance-setup';
import { describeImageWithVision } from './image-describe';
import logger from '../../utils/logger';
import prisma from '../../config/database';

// ── Multer setup for knowledge base uploads ───────────────────────────────────

const ALLOWED_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  // Images — described via GPT-4o vision for RAG
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif',
  'image/heic', 'image/heif',
]);

export const knowledgeUploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB for knowledge base docs
  fileFilter: (_req, file, cb) => {
    const allowed = ALLOWED_TYPES.has(file.mimetype)
      || file.originalname.endsWith('.pdf')
      || file.originalname.endsWith('.docx')
      || file.originalname.endsWith('.txt')
      || file.originalname.endsWith('.md')
      || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(file.originalname);
    cb(null, allowed);
  },
}).single('file');

// ── Vision: describe an image for RAG ────────────────────────────────────────
// The vision hop itself is the SHARED capability in ./image-describe (also used
// by the feedback-ticket pipeline); this wrapper only adds the KB framing.

export async function describeImageForKnowledgeBase(
  buffer: Buffer,
  mimeType: string,
  filename: string
): Promise<string> {
  const description = await describeImageWithVision(buffer, mimeType, filename);
  return `[IMAGE: ${filename}]\n\n${description}`;
}

// ── Helper: check project access ─────────────────────────────────────────────

async function canEditProject(projectId: string, userId: string): Promise<boolean> {
  const project = await prisma.crossModelProject.findUnique({
    where: { id: projectId },
    include: { members: { where: { userId } } },
  });
  if (!project) return false;
  if (project.userId === userId) return true;
  const member = project.members[0];
  return member ? member.role !== 'viewer' : false;
}

// ── Upload file to project ────────────────────────────────────────────────────

export async function uploadDocumentToProject(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id: projectId } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided or unsupported type. Supported: PDF, DOCX, TXT, MD' });
    }

    // Check project access
    const canEdit = await canEditProject(projectId, userId);
    if (!canEdit) {
      return res.status(403).json({ error: 'No edit access to this project' });
    }

    const { originalname, mimetype, buffer } = req.file;

    // Extract text (or vision-describe for images)
    let rawText: string;
    if (mimetype.startsWith('image/')) {
      try {
        rawText = await describeImageForKnowledgeBase(buffer, mimetype, originalname);
      } catch (err: any) {
        return res.status(422).json({ error: err.message });
      }
    } else {
      try {
        rawText = await extractTextFromBuffer(buffer, mimetype, originalname);
      } catch (err: any) {
        return res.status(422).json({ error: err.message });
      }
      if (!rawText?.trim()) {
        return res.status(422).json({ error: 'Could not extract any text from this file. It may be empty or image-based.' });
      }
    }

    // Create document record
    const doc = await prisma.projectDocument.create({
      data: {
        projectId,
        userId,
        name: originalname,
        mimeType: mimetype,
        status: 'processing',
        charCount: rawText.length,
      },
    });

    // Fire-and-forget ingestion (non-blocking)
    processDocument(doc.id, rawText).catch(err => {
      logger.error(`Background ingestion failed for doc ${doc.id}:`, err.message);
    });

    res.status(201).json({
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      status: doc.status,
      charCount: rawText.length,
      createdAt: doc.createdAt,
    });
  } catch (err: any) {
    logger.error('uploadDocumentToProject error:', err);
    res.status(500).json({ error: 'Failed to upload document' });
  }
}

// ── Add URL to project knowledge base ────────────────────────────────────────

export async function addUrlToProject(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id: projectId } = req.params;
    const { url, name } = req.body;

    if (!url?.trim()) {
      return res.status(400).json({ error: 'url is required' });
    }

    // Basic URL validation
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    // Self-host setup hardening (2026-10-20): a URL cannot be fetched on an
    // instance with no search / page-reading backend — refuse before creating
    // a document row that would sit in 'processing' and then fail.
    if (webSearchMissingOnInstance()) {
      return res.status(409).json({
        error: 'Adding a URL needs web page fetching, which is not set up on this Digby instance. An admin enables web search under Account → Admin → Setup → Web search.',
        code: 'web_search_not_configured',
      });
    }

    const canEdit = await canEditProject(projectId, userId);
    if (!canEdit) {
      return res.status(403).json({ error: 'No edit access to this project' });
    }

    // Derive display name from URL if not provided
    const displayName = name?.trim() || (() => {
      try {
        const u = new URL(url);
        return u.hostname + (u.pathname !== '/' ? u.pathname : '');
      } catch {
        return url.substring(0, 80);
      }
    })();

    // Create document record
    const doc = await prisma.projectDocument.create({
      data: {
        projectId,
        userId,
        name: displayName,
        mimeType: 'url',
        sourceUrl: url.trim(),
        status: 'processing',
      },
    });

    // Fire-and-forget URL analysis + ingestion
    processDocument(doc.id).catch(err => {
      logger.error(`Background URL ingestion failed for doc ${doc.id}:`, err.message);
    });

    res.status(201).json({
      id: doc.id,
      name: doc.name,
      mimeType: doc.mimeType,
      sourceUrl: doc.sourceUrl,
      status: doc.status,
      createdAt: doc.createdAt,
    });
  } catch (err: any) {
    logger.error('addUrlToProject error:', err);
    res.status(500).json({ error: 'Failed to add URL' });
  }
}

// ── Add Gmail attachment to project knowledge base (ticket 99145890) ─────────

/**
 * POST /projects/:id/documents/gmail-attachment  { messageId, filename, label? }
 *
 * The UI leg of Gmail→KB ingestion: fetch the attachment through the same
 * download path gmail_get_attachment uses, extract it with the KB-standard
 * extractors (vision hop for images) and file it as a ProjectDocument with the
 * gmail://<messageId>/<filename> dedup key. A repeat add of the same
 * attachment answers 200 {duplicate:true} with the existing doc id.
 */
export async function addGmailAttachmentToProject(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { id: projectId } = req.params;
    const { messageId, filename, label } = req.body as { messageId?: string; filename?: string; label?: string };

    if (!messageId?.trim() || !filename?.trim()) {
      return res.status(400).json({ error: 'messageId and filename are required' });
    }

    const canEdit = await canEditProject(projectId, userId);
    if (!canEdit) {
      return res.status(403).json({ error: 'No edit access to this project' });
    }

    const { ingestGmailAttachment } = await import('./gmail-knowledge.service');
    const result = await ingestGmailAttachment({
      projectId, userId,
      messageId: messageId.trim(),
      filename: filename.trim(),
      sessionId: `rest:${req.user!.id}`,
      label: label?.trim() || undefined,
    });

    if (result.outcome === 'error') {
      const status = result.reason === 'project_full' || result.reason === 'too_large' ? 422
        : result.reason === 'rate_limited' ? 429
        : result.reason === 'not_found' ? 404 : 422;
      return res.status(status).json({ error: result.message, reason: result.reason });
    }
    return res.status(result.outcome === 'created' ? 201 : 200).json({
      id: result.documentId,
      name: result.name,
      source: 'gmail_attachment',
      sourceUrl: `gmail://${messageId.trim()}/${filename.trim()}`,
      status: result.status,
      charCount: result.outcome === 'created' ? result.charCount : undefined,
      duplicate: result.outcome === 'duplicate',
    });
  } catch (err: any) {
    logger.error('addGmailAttachmentToProject error:', err);
    res.status(500).json({ error: 'Failed to ingest Gmail attachment' });
  }
}

// ── Delete document ───────────────────────────────────────────────────────────

export async function deleteDocument(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { docId } = req.params;

    const doc = await prisma.projectDocument.findUnique({ where: { id: docId } });
    if (!doc || doc.userId !== userId) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Delete document (cascades to project_chunks via FK)
    await prisma.projectDocument.delete({ where: { id: docId } });

    res.json({ success: true });
  } catch (err: any) {
    logger.error('deleteDocument error:', err);
    res.status(500).json({ error: 'Failed to delete document' });
  }
}

// ── Get document processing status ───────────────────────────────────────────

export async function getDocumentStatus(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const { docId } = req.params;

    // Filter by both docId AND userId — prevents any authenticated user from
    // polling another user's document status by guessing UUIDs (IDOR fix).
    const doc = await prisma.projectDocument.findFirst({
      where: { id: docId, userId },
      select: {
        id: true,
        status: true,
        chunkCount: true,
        charCount: true,
        errorMsg: true,
      },
    });

    if (!doc) {
      // Return 404 for both "not found" and "not yours" — avoids leaking existence
      return res.status(404).json({ error: 'Document not found' });
    }

    res.json({
      id: doc.id,
      status: doc.status,
      chunkCount: doc.chunkCount,
      charCount: doc.charCount,
      errorMsg: doc.errorMsg,
    });
  } catch (err: any) {
    logger.error('getDocumentStatus error:', err);
    res.status(500).json({ error: 'Failed to get document status' });
  }
}

export default {
  uploadDocumentToProject,
  addUrlToProject,
  addGmailAttachmentToProject,
  deleteDocument,
  getDocumentStatus,
  knowledgeUploadMiddleware,
};
