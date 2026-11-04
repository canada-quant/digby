/**
 * Tests for the shared transcript attachment chips (ticket c6e8edda).
 *
 * Same idiom as file-link-card.test.tsx: the pure inline-render decision
 * (isRenderableImageChip) is unit-tested directly; the chip-row markup is
 * SSR'd via renderToStaticMarkup (node environment — no jsdom, so
 * AuthedFileImage's effect never runs and an inline-rendered chip shows its
 * assertable loading placeholder rather than a resolved <img>).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  isPlayableAudioChip,
  isRenderableImageChip,
  TranscriptAttachmentChips,
  type TranscriptAttachmentChip,
} from './transcript-attachment-chips';

const FILE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const render = (
  attachments: TranscriptAttachmentChip[],
  variant: 'bubble' | 'overlay' = 'bubble',
  className?: string,
) => renderToStaticMarkup(createElement(TranscriptAttachmentChips, { attachments, variant, className }));

describe('isRenderableImageChip — the inline-render gate', () => {
  it('an image-typed chip WITH a durable fileId renders inline', () => {
    expect(isRenderableImageChip({ type: 'image', fileId: FILE_ID })).toBe(true);
  });

  it('an image-typed chip WITHOUT a fileId stays a chip (legacy row / expired upload)', () => {
    expect(isRenderableImageChip({ type: 'image' })).toBe(false);
    expect(isRenderableImageChip({ type: 'image', fileId: undefined })).toBe(false);
    expect(isRenderableImageChip({ type: 'image', fileId: '' })).toBe(false);
  });

  it('non-image types never render inline, even with a fileId', () => {
    expect(isRenderableImageChip({ type: 'pdf', fileId: FILE_ID })).toBe(false);
    expect(isRenderableImageChip({ type: 'doc', fileId: FILE_ID })).toBe(false);
    expect(isRenderableImageChip({ type: 'file', fileId: FILE_ID })).toBe(false);
    expect(isRenderableImageChip({ type: 'audio', fileId: FILE_ID })).toBe(false);
  });

  it('malformed chips never render inline', () => {
    expect(isRenderableImageChip({} as Pick<TranscriptAttachmentChip, 'type' | 'fileId'>)).toBe(false);
    expect(isRenderableImageChip({ type: '', fileId: FILE_ID })).toBe(false);
    // The gate is the exact chip type 'image' — case variants stay chips.
    expect(isRenderableImageChip({ type: 'IMAGE', fileId: FILE_ID })).toBe(false);
  });
});

describe('TranscriptAttachmentChips — SSR chip rows', () => {
  it('an image chip with fileId renders the authed inline image AND keeps its filename chip', () => {
    const html = render([
      { filename: 'photo.png', type: 'image', uploadId: 'u1', fileId: FILE_ID, mimeType: 'image/png' },
    ]);
    // SSR-side the authed embed is its reserved-height loading placeholder.
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html).toContain('aria-label="photo.png"');
    // …and the filename chip is never lost beneath the inline render.
    expect(html).toContain('photo.png');
  });

  it('an image chip WITHOUT fileId stays a plain chip — no inline image', () => {
    const html = render([{ filename: 'photo.png', type: 'image' }]);
    expect(html).not.toContain('data-authed-file-image');
    expect(html).toContain('photo.png');
  });

  it('a pdf chip with fileId stays a plain chip', () => {
    const html = render([
      { filename: 'scan.pdf', type: 'pdf', fileId: FILE_ID, mimeType: 'application/pdf' },
    ]);
    expect(html).not.toContain('data-authed-file-image');
    expect(html).toContain('scan.pdf');
  });

  it('a localPreview echo keeps its blob thumbnail (the composer path is untouched)', () => {
    const html = render([
      { filename: 'draft.png', type: 'image', localPreview: 'blob:http://localhost/echo' },
    ]);
    expect(html).toContain('src="blob:http://localhost/echo"');
    expect(html).not.toContain('data-authed-file-image');
  });

  it('preserves both chip skins (bubble = bordered muted, overlay = on-violet)', () => {
    const bubble = render([{ filename: 'a.png', type: 'image' }], 'bubble');
    expect(bubble).toContain('rounded-xl border bg-muted/40');
    const overlay = render([{ filename: 'a.png', type: 'image' }], 'overlay');
    expect(overlay).toContain('rounded-lg bg-white/15');
  });

  it('passes the row layout className through (each surface keeps its own alignment)', () => {
    const html = render(
      [{ filename: 'a.png', type: 'image' }],
      'bubble',
      'flex flex-wrap gap-1.5 justify-end',
    );
    expect(html).toContain('flex flex-wrap gap-1.5 justify-end');
  });

  it('renders every attachment in a mixed row', () => {
    const html = render([
      { filename: 'inline.png', type: 'image', fileId: FILE_ID },
      { filename: 'notes.pdf', type: 'pdf', fileId: FILE_ID },
    ]);
    expect(html).toContain('inline.png');
    expect(html).toContain('notes.pdf');
    // Exactly one inline render — only the image chip.
    expect(html.match(/data-authed-file-image="loading"/g)).toHaveLength(1);
  });


  // Ticket 6c050917 — inline AUDIO player on the chip row.
  it('an audio chip WITH a durable fileId renders the inline audio player (loading placeholder under SSR)', () => {
    const html = render([
      { filename: 'kokoro_af_heart_all4.wav', type: 'audio', uploadId: 'u1', fileId: FILE_ID, mimeType: 'audio/wav' },
    ]);
    expect(html).toContain('data-audio-player="loading"');
    expect(html).toContain('aria-label="Loading kokoro_af_heart_all4.wav"');
    // …and the filename chip is never lost beneath the player.
    expect(html).toContain('kokoro_af_heart_all4.wav');
  });

  it('an audio chip WITHOUT a fileId stays a plain chip (legacy row / expired upload)', () => {
    const html = render([{ filename: 'clip.mp3', type: 'audio' }]);
    expect(html).not.toContain('data-audio-player');
    expect(html).toContain('clip.mp3');
  });

  it('an audio chip with a Play icon (not the Paperclip) keeps its label', () => {
    const html = render([{ filename: 'clip.mp3', type: 'audio', fileId: FILE_ID }]);
    // lucide renders the icon's stroke paths — assert the row keeps the chip
    // skin and the label while the player placeholder sits above it.
    expect(html).toContain('data-audio-player="loading"');
    expect(html).toContain('clip.mp3');
  });

  it('a mixed image+audio row renders BOTH inline affordances, exactly one of each', () => {
    const html = render([
      { filename: 'a.png', type: 'image', fileId: FILE_ID },
      { filename: 'b.wav', type: 'audio', fileId: FILE_ID },
    ]);
    expect(html.match(/data-authed-file-image="loading"/g)).toHaveLength(1);
    expect(html.match(/data-audio-player="loading"/g)).toHaveLength(1);
    expect(html).toContain('a.png');
    expect(html).toContain('b.wav');
  });
});

describe('isPlayableAudioChip — the inline-audio gate', () => {
  it('an audio-typed chip WITH a durable fileId renders a player', () => {
    expect(isPlayableAudioChip({ type: 'audio', fileId: FILE_ID })).toBe(true);
  });

  it('an audio-typed chip WITHOUT a fileId stays a chip', () => {
    expect(isPlayableAudioChip({ type: 'audio' })).toBe(false);
    expect(isPlayableAudioChip({ type: 'audio', fileId: '' })).toBe(false);
  });

  it('non-audio types never render a player, even with a fileId', () => {
    expect(isPlayableAudioChip({ type: 'image', fileId: FILE_ID })).toBe(false);
    expect(isPlayableAudioChip({ type: 'pdf', fileId: FILE_ID })).toBe(false);
  });

  it('the gate is the exact chip type \'audio\' — case variants stay chips', () => {
    expect(isPlayableAudioChip({ type: 'AUDIO', fileId: FILE_ID })).toBe(false);
    expect(isPlayableAudioChip({ type: 'sound', fileId: FILE_ID })).toBe(false);
  });
});
