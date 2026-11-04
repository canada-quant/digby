/**
 * Backfill script: scan all existing CrossModel chat messages for file attachments
 * and create ProjectDocument records for any non-image files that don't already exist.
 *
 * Files uploaded before auto-ingestion was added (Feb 25 2026) were never stored
 * in project_documents. This script creates placeholder records so they appear in
 * the /files page. The content is no longer available (deleted after 15-min TTL),
 * so records are marked as 'error' with instructions to re-upload.
 *
 * Usage (inside backend container):
 *   node scripts/backfill-chat-uploads.js
 */

require('dotenv/config');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });

async function main() {
  console.log('\n🔍 Backfill: Scanning CrossModel chats for historical file uploads...\n');

  // Load all chats with messages
  const chats = await prisma.crossModelChat.findMany({
    select: {
      id: true,
      userId: true,
      projectId: true,
      title: true,
      messages: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`📋 Found ${chats.length} chats to scan.\n`);

  let created = 0;
  let alreadyExists = 0;
  let imageSkipped = 0;
  let noAttachments = 0;

  for (const chat of chats) {
    const messages = Array.isArray(chat.messages) ? chat.messages : [];

    for (const msg of messages) {
      // Only look at user messages with attachments
      if (msg.role !== 'user') continue;
      if (!msg.attachmentInfo || !Array.isArray(msg.attachmentInfo) || msg.attachmentInfo.length === 0) {
        continue;
      }

      for (const attachment of msg.attachmentInfo) {
        const filename = attachment.filename || 'unknown';
        const type = attachment.type || 'document';

        // Skip images — they're visual-only (AI vision), not knowledge base material
        if (type === 'image') {
          imageSkipped++;
          continue;
        }

        // Check if a record already exists for this file in this user's context
        // Dedup by: userId + filename + source + projectId (or null)
        const existing = await prisma.projectDocument.findFirst({
          where: {
            userId: chat.userId,
            name: filename,
            source: 'chat_upload',
            projectId: chat.projectId || null,
          },
        });

        if (existing) {
          alreadyExists++;
          continue;
        }

        // Infer MIME type from the attachment type and filename
        let mimeType;
        if (type === 'pdf') {
          mimeType = 'application/pdf';
        } else if (filename.toLowerCase().endsWith('.docx')) {
          mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        } else if (filename.toLowerCase().endsWith('.pdf')) {
          mimeType = 'application/pdf';
        } else {
          mimeType = 'text/plain';
        }

        // Create stub record — content is gone (15-min TTL on tmp files)
        // Mark as 'error' so it shows up in /files but user knows to re-upload
        try {
          const doc = await prisma.projectDocument.create({
            data: {
              userId: chat.userId,
              projectId: chat.projectId || null,
              name: filename,
              mimeType: mimeType,
              source: 'chat_upload',
              status: 'error',
              errorMsg: 'File content not available — uploaded before auto-ingestion was added (Feb 2026). Re-upload this file to enable knowledge search.',
              charCount: 0,
              chunkCount: 0,
            },
          });

          created++;
          const projectLabel = chat.projectId ? `→ project ${chat.projectId.slice(0, 8)}` : '(ungrouped)';
          console.log(`  ✅ "${filename}" ${projectLabel}  [chat: "${chat.title.slice(0, 40)}"]`);
        } catch (err) {
          console.error(`  ❌ Failed to create record for "${filename}":`, err.message);
        }
      }
    }
  }

  console.log('\n─────────────────────────────────────────');
  console.log(`📊 Backfill complete!`);
  console.log(`  ✅ Created:           ${created} document records`);
  console.log(`  ⏭️  Already existed:   ${alreadyExists} (skipped)`);
  console.log(`  🖼️  Images skipped:    ${imageSkipped} (visual-only, not indexable)`);
  console.log('─────────────────────────────────────────\n');

  if (created > 0) {
    console.log('💡 These files are now visible in /files with "Chat" badge.');
    console.log('   They show status "Error" because the original content is gone.');
    console.log('   Users can re-upload files to add them to the knowledge base.\n');
  } else {
    console.log('💡 No new records needed — all chat uploads are already accounted for.\n');
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('Script failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
