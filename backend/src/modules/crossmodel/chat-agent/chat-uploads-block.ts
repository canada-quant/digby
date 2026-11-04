/**
 * chat-uploads-block (ticket 6e15a4c8) — the compact "this chat's uploads"
 * context block auto-injected into systemContext (chat-context.ts 1e-bis) so
 * answers can PROACTIVELY include the media and files the user shared in the
 * chat — the request behind "level 2/3 should automatically include photos,
 * media, files relevant in chat or file tree".
 *
 * Metadata only (filename + owner-auth'd serve URL): bytes never re-enter
 * model context. The URL shapes below are exactly the ones the chat markdown
 * renderer promotes to inline images (AuthedFileImage) / download cards
 * (FileLinkCard) — see frontend file-link-card.tsx CHAT_FILE_PATH_RE.
 *
 * PURE LEAF: zero imports — safe to static-import anywhere and unit-test
 * without mocking the world.
 */

export interface ChatUploadBrief {
  id: string;
  filename: string;
  mimeType: string | null;
  sizeBytes: number | null;
}

/** Max uploads listed (most recent first) — keeps the block's token cost flat. */
export const CHAT_UPLOADS_BLOCK_MAX = 12;

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Images embed inline EXCEPT svg/html-adjacent types — the renderer refuses to
 * blob-render those (script-injection guard, isBlobRenderableImage), so they
 * get the download-link treatment instead. Audio (ticket 6c050917) embeds via
 * the SAME inline-route link form the renderer routes to the audio player.
 */
function isInlineEmbeddableImage(mimeType: string | null): boolean {
  if (!mimeType) return false;
  const m = mimeType.toLowerCase();
  return m.startsWith('image/') && !m.includes('svg') && !m.includes('html');
}

/** Audio clips play inline (AudioFilePlayer — ticket 6c050917). */
function isInlineEmbeddableAudio(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return mimeType.toLowerCase().startsWith('audio/');
}

/**
 * Build the system-context block listing a chat's uploads, or '' when the
 * chat has none (caller skips appending). `rows` must be most-recent-first.
 */
export function buildChatUploadsBlock(rows: ChatUploadBrief[]): string {
  if (!rows.length) return '';
  const listed = rows.slice(0, CHAT_UPLOADS_BLOCK_MAX);
  const lines = listed.map((r) => {
    const size = formatSize(r.sizeBytes);
    const meta = [r.mimeType || 'file', size].filter(Boolean).join(' · ');
    if (isInlineEmbeddableImage(r.mimeType)) {
      return `- ${r.filename} (${meta}) — embed inline: ![${r.filename}](/api/crossmodel/files/${r.id}/inline)`;
    }
    // Audio (ticket 6c050917): a bare inline-route LINK (not ![]) — the
    // markdown anchor renderer routes exactly this shape to the inline
    // AudioFilePlayer, play/pause + scrubber, no download needed.
    if (isInlineEmbeddableAudio(r.mimeType)) {
      return `- ${r.filename} (${meta}) — play inline: [${r.filename}](/api/crossmodel/files/${r.id}/inline)`;
    }
    return `- ${r.filename} (${meta}) — link: [${r.filename}](/api/crossmodel/files/${r.id}/download)`;
  });
  const overflow = rows.length - listed.length;
  if (overflow > 0) {
    lines.push(`- …and ${overflow} more (call list_files for the full inventory)`);
  }
  return `═══ THIS CHAT'S UPLOADS (media & files the user shared in this chat) ═══
${lines.join('\n')}
When one of these is directly relevant to the answer, include it proactively — embed images inline with the markdown syntax above, link other files with the download URL. Relevance-gated: include only items that genuinely help the answer; NEVER dump the whole list, and ignore this block entirely when nothing here is relevant.
═══════════════════`;
}
