/**
 * chat-uploads-block (ticket 6e15a4c8) — pins the auto-injected "this chat's
 * uploads" context block: images get the inline-embed syntax the chat markdown
 * renderer promotes to an inline image, svg/html-adjacent types and non-images
 * get download links, the list is capped with an overflow note, and an empty
 * upload list produces no block at all.
 */

import { buildChatUploadsBlock, CHAT_UPLOADS_BLOCK_MAX } from './chat-uploads-block';

const img = (id: string, filename = 'photo.jpg') => ({ id, filename, mimeType: 'image/jpeg', sizeBytes: 1_200_000 });

describe('buildChatUploadsBlock (ticket 6e15a4c8)', () => {
  it('returns an empty string when the chat has no uploads (caller skips appending)', () => {
    expect(buildChatUploadsBlock([])).toBe('');
  });

  it('images get the /inline embed syntax with the exact route the renderer recognizes', () => {
    const out = buildChatUploadsBlock([img('abc-123', 'sunset.png')]);
    expect(out).toContain("THIS CHAT'S UPLOADS");
    expect(out).toContain('![sunset.png](/api/crossmodel/files/abc-123/inline)');
    expect(out).toContain('image/jpeg · 1.1 MB');
    // relevance guard rides the block itself
    expect(out).toContain('directly relevant');
    expect(out).toContain('NEVER dump the whole list');
  });

  it('svg images and non-images get download links, not inline embeds', () => {
    const out = buildChatUploadsBlock([
      { id: 's1', filename: 'icon.svg', mimeType: 'image/svg+xml', sizeBytes: 2048 },
      { id: 'p1', filename: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 240_000 },
      { id: 't1', filename: 'notes.txt', mimeType: 'text/plain', sizeBytes: null },
    ]);
    expect(out).toContain('[icon.svg](/api/crossmodel/files/s1/download)');
    expect(out).not.toContain('files/s1/inline');
    expect(out).toContain('[report.pdf](/api/crossmodel/files/p1/download)');
    expect(out).toContain('application/pdf · 234 KB');
    expect(out).toContain('[notes.txt](/api/crossmodel/files/t1/download)');
  });

  it('audio uploads get the play-inline LINK form (ticket 6c050917 — the anchor renderer routes it to the audio player)', () => {
    const out = buildChatUploadsBlock([
      { id: 'w1', filename: 'kokoro_af_heart_all4.wav', mimeType: 'audio/wav', sizeBytes: 884_736 },
      { id: 'w2', filename: 'phonon-31m-en_Easton_all4.wav', mimeType: 'audio/wav', sizeBytes: 884_736 },
    ]);
    // Bare inline-route link (NOT the ![] image form): the markdown anchor
    // renderer routes exactly this shape to AudioFilePlayer.
    expect(out).toContain('play inline: [kokoro_af_heart_all4.wav](/api/crossmodel/files/w1/inline)');
    expect(out).toContain('[phonon-31m-en_Easton_all4.wav](/api/crossmodel/files/w2/inline)');
    // NOT the download link, NOT the image embed.
    expect(out).not.toContain('files/w1/download');
    expect(out).not.toContain('![kokoro');
    expect(out).toContain('audio/wav · 864 KB');
  });

  it('a non-audio non-image type still gets the download link (audio loosens nothing else)', () => {
    const out = buildChatUploadsBlock([
      { id: 'z1', filename: 'archive.zip', mimeType: 'application/zip', sizeBytes: 2048 },
    ]);
    expect(out).toContain('[archive.zip](/api/crossmodel/files/z1/download)');
    expect(out).not.toContain('files/z1/inline');
  });

  it('an audio mime with parameters/case still counts as audio (essence rule)', () => {
    const out = buildChatUploadsBlock([
      { id: 'm1', filename: 'voice.mp3', mimeType: 'AUDIO/MPEG; charset=utf-8', sizeBytes: 2048 },
    ]);
    expect(out).toContain('[voice.mp3](/api/crossmodel/files/m1/inline)');
  });

  it('caps the list and notes the overflow', () => {
    const rows = Array.from({ length: CHAT_UPLOADS_BLOCK_MAX + 3 }, (_, i) => img(`id-${i}`, `p${i}.jpg`));
    const out = buildChatUploadsBlock(rows);
    expect(out).toContain('![p0.jpg]');
    expect(out).toContain(`![p${CHAT_UPLOADS_BLOCK_MAX - 1}.jpg]`);
    expect(out).not.toContain(`![p${CHAT_UPLOADS_BLOCK_MAX}.jpg]`);
    expect(out).toContain('and 3 more (call list_files for the full inventory)');
  });

  it('formats sizes and tolerates missing metadata', () => {
    const out = buildChatUploadsBlock([
      { id: 'a', filename: 'tiny.gif', mimeType: 'image/gif', sizeBytes: 512 },
      { id: 'b', filename: 'mystery', mimeType: null, sizeBytes: null },
    ]);
    expect(out).toContain('image/gif · 512 B');
    expect(out).toContain('- mystery (file) — link: [mystery](/api/crossmodel/files/b/download)');
  });
});
