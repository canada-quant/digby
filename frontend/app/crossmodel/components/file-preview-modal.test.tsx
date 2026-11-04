/**
 * Tests for the FilePreviewModal's pure mime routing (2026-08-31) + the
 * ChatFilesSectionView changes it enables (image thumbnails, widened Preview
 * gate, no eager modal markup).
 *
 * The modal body fetches (blob/preview-text) in effects, which never run
 * under the repo's node-environment SSR idiom — so the routing DECISIONS are
 * pinned here at the pure-function level, and the view-level asserts only
 * cover static markup (same discipline as image-lightbox.test.tsx).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { previewKindForMime, byteInlineOpenable } from './file-preview-modal';
import { ChatFilesSectionView } from './ChatFilesSection';
import type { ChatFileMeta } from '@/lib/api/crossmodel';

const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
const mk = (over: Partial<ChatFileMeta>): ChatFileMeta => ({
  id: 'f1', filename: 'f.bin', mimeType: 'application/octet-stream',
  sizeBytes: 1, createdAt: twoDaysAgo, uploadId: null, ...over,
});

describe('previewKindForMime', () => {
  it('routes images to image, pdf to pdf, text/json/xml + office types to text', () => {
    expect(previewKindForMime('image/png')).toBe('image');
    expect(previewKindForMime('image/jpeg; x=1')).toBe('image');
    expect(previewKindForMime('application/pdf')).toBe('pdf');
    expect(previewKindForMime('text/plain')).toBe('text');
    expect(previewKindForMime('text/markdown; charset=utf-8')).toBe('text');
    expect(previewKindForMime('application/json')).toBe('text');
    expect(previewKindForMime('application/xml')).toBe('text');
    expect(previewKindForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('text');
    expect(previewKindForMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('text');
    expect(previewKindForMime('application/vnd.ms-excel')).toBe('text');
  });

  it('B1: html + svg essences route to null (never preview, incl. parameterized variants)', () => {
    expect(previewKindForMime('text/html')).toBeNull();
    expect(previewKindForMime('Text/HTML; charset=utf-8')).toBeNull();
    expect(previewKindForMime('image/svg+xml')).toBeNull();
    expect(previewKindForMime('IMAGE/SVG+XML')).toBeNull();
  });

  it('unknown/binary families route to null', () => {
    expect(previewKindForMime('application/zip')).toBeNull();
    expect(previewKindForMime('application/octet-stream')).toBeNull();
    expect(previewKindForMime('')).toBeNull();
  });

  it('heic/heif route to null (no browser decodes them — a broken thumbnail is worse than none)', () => {
    expect(previewKindForMime('image/heic')).toBeNull();
    expect(previewKindForMime('image/heif')).toBeNull();
    expect(previewKindForMime('IMAGE/HEIC; x=1')).toBeNull();
  });
});

describe('byteInlineOpenable (secondary new-tab action gate)', () => {
  it('allows image/pdf/text but not html/svg or office types (the byte route 415s those)', () => {
    expect(byteInlineOpenable('image/png')).toBe(true);
    expect(byteInlineOpenable('application/pdf')).toBe(true);
    expect(byteInlineOpenable('text/plain')).toBe(true);
    expect(byteInlineOpenable('text/html')).toBe(false);
    expect(byteInlineOpenable('image/svg+xml')).toBe(false);
    expect(byteInlineOpenable('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
    expect(byteInlineOpenable('application/zip')).toBe(false);
  });
});

describe('ChatFilesSectionView — preview wiring (2026-08-31)', () => {
  const render = (uploads: ChatFileMeta[]) =>
    renderToStaticMarkup(createElement(ChatFilesSectionView, { uploads, generated: [], status: 'ready' as const }));

  it('docx + xlsx upload rows now get a Preview action (the widened gate)', () => {
    const html = render([
      mk({ id: 'd1', filename: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
      mk({ id: 'x1', filename: 'data.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    ]);
    expect(html.match(/Preview/g) || []).toHaveLength(2);
  });

  it('an image row renders the authed thumbnail slot instead of the generic icon', () => {
    const html = render([mk({ id: 'i1', filename: 'photo.png', mimeType: 'image/png' })]);
    // AuthedFileImage SSR = its loading placeholder (the effect never runs).
    expect(html).toContain('data-authed-file-image="loading"');
  });

  it('a non-image row keeps the type icon and renders no thumbnail slot', () => {
    const html = render([mk({ id: 'p1', filename: 'report.pdf', mimeType: 'application/pdf' })]);
    expect(html).not.toContain('data-authed-file-image');
  });

  it('mounts NO preview modal in static markup (collapsed first render)', () => {
    const html = render([mk({ id: 'p1', filename: 'report.pdf', mimeType: 'application/pdf' })]);
    expect(html).not.toContain('role="dialog"');
  });
});
