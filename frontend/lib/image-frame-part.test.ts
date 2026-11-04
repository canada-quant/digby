/**
 * image-frame-part — the ONE live/replayed `image` frame → transcript part
 * mapping both lanes use (2026-09-24 review). Pins: the generated fields
 * (url / fileId / prompt) ride through; a url-only replayed frame is a part
 * (no `data` key); a frame with neither bytes nor url is null; non-string
 * junk never lands on the part; screenshots map exactly as before.
 */
import { describe, expect, it } from 'vitest';
import { imagePartFromFrame } from './image-frame-part';

const FILE_ID = '11111111-2222-3333-4444-555555555555';
const INLINE = `/api/crossmodel/generated-files/${FILE_ID}/inline`;

describe('imagePartFromFrame', () => {
  it('a live generated frame keeps data AND url / fileId / prompt (the Download / Open row renders live)', () => {
    const part = imagePartFromFrame({ mediaType: 'image/png', data: 'AAAA', name: 'Generated · "fox"', source: 'generated', url: INLINE, fileId: FILE_ID, prompt: 'a fox' });
    expect(part).toEqual({ type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'Generated · "fox"', source: 'generated', pageUrl: undefined, app: undefined, url: INLINE, fileId: FILE_ID, prompt: 'a fox' });
  });

  it('a url-only replayed frame (durable log / mirror stripped the base64) is a part without a data key', () => {
    const part = imagePartFromFrame({ mediaType: 'image/png', source: 'generated', url: INLINE, fileId: FILE_ID });
    expect(part).toMatchObject({ type: 'image', mediaType: 'image/png', source: 'generated', url: INLINE, fileId: FILE_ID });
    expect(part).not.toHaveProperty('data');
  });

  it('neither bytes nor url → null; non-object → null; the mediaType defaults to image/png', () => {
    expect(imagePartFromFrame({ mediaType: 'image/png', source: 'generated' })).toBeNull();
    expect(imagePartFromFrame({ mediaType: 'image/png', data: '' })).toBeNull();
    expect(imagePartFromFrame(undefined)).toBeNull();
    expect(imagePartFromFrame('x')).toBeNull();
    expect(imagePartFromFrame({ data: 'AAAA' })?.mediaType).toBe('image/png');
  });

  it('non-string url / fileId / prompt never leak onto the part', () => {
    const part = imagePartFromFrame({ mediaType: 'image/png', data: 'x', url: 42, fileId: null, prompt: {} });
    expect(part).not.toHaveProperty('url');
    expect(part).not.toHaveProperty('fileId');
    expect(part).not.toHaveProperty('prompt');
  });

  it('screenshots map exactly as before (source / pageUrl / app preserved)', () => {
    const shot = { mediaType: 'image/jpeg', data: 'BBBB', name: 'Final screen · Your Mac · Chrome', source: 'computer', app: 'Chrome' };
    expect(imagePartFromFrame(shot)).toEqual({ type: 'image', ...shot, pageUrl: undefined });
  });
});
