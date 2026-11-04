/**
 * Renderer tests for ChatFilesSectionView (ticket 57ef1b9f PR2).
 *
 * The connected ChatFilesSection wrapper fetches via apiClient (not testable
 * under the repo's node-environment vitest idiom — no jsdom, no effects), so
 * these tests target the PURE view via react-dom/server, the same pattern as
 * markdown-content.test.tsx: list rows, the ONE empty state (2026-10-07: one
 * files list, documents included — never "Artifacts"), and the
 * honest error state (an errored fetch must never masquerade as "no files").
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ChatFilesSectionView } from './ChatFilesSection';
import type { ChatFileMeta, GeneratedFileMeta } from '@/lib/api/crossmodel';

const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();

const UPLOADS: ChatFileMeta[] = [
  { id: 'u1', filename: 'quarterly-report.pdf', mimeType: 'application/pdf', sizeBytes: 2048, createdAt: twoDaysAgo, uploadId: 'up1' },
  { id: 'u2', filename: 'photo.png', mimeType: 'image/png', sizeBytes: 5 * 1024 * 1024, createdAt: twoDaysAgo, uploadId: null },
  // Not inline-previewable (mirrors the backend's isInlineSafe) → no Preview action.
  { id: 'u3', filename: 'archive.zip', mimeType: 'application/zip', sizeBytes: 512, createdAt: twoDaysAgo, uploadId: 'up3' },
];

const GENERATED: GeneratedFileMeta[] = [
  {
    id: 'g1',
    filename: 'summary.xlsx',
    format: 'xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 4096,
    createdAt: twoDaysAgo,
    chatId: 'chat-1',
  },
];

const render = (props: Parameters<typeof ChatFilesSectionView>[0]) =>
  renderToStaticMarkup(createElement(ChatFilesSectionView, props));

describe('ChatFilesSectionView — ready with rows', () => {
  const html = render({ uploads: UPLOADS, generated: GENERATED, status: 'ready' });

  it('renders ONE list with one total count — no per-kind subsections, no second "Files" heading', () => {
    expect(html).not.toContain('>Files</h3>');
    expect(html).toContain('4 files');
    expect(html).not.toContain('Uploads');
    expect(html).not.toContain('Created by Digby');
    expect(html).not.toMatch(/artifact/i);
    expect(html.match(/<ul /g) || []).toHaveLength(1);
  });

  it('renders filenames, humanized sizes, and relative dates', () => {
    expect(html).toContain('quarterly-report.pdf');
    expect(html).toContain('photo.png');
    expect(html).toContain('archive.zip');
    expect(html).toContain('summary.xlsx');
    expect(html).toContain('2.0 KB');
    expect(html).toContain('5.0 MB');
    expect(html).toContain('512 B');
    expect(html).toContain('4.0 KB');
    expect(html).toContain('2 days ago');
  });

  it('regression: pdf + png rows still get Preview, zip stays Download-only', () => {
    // pdf + png previewable, zip is not → exactly 2 Preview buttons.
    expect(html.match(/Preview/g) || []).toHaveLength(2);
    // 3 uploads + 1 generated → 4 Download buttons.
    expect(html.match(/Download file/g) || []).toHaveLength(4);
  });

  it('renders the generated file format badge', () => {
    expect(html).toContain('uppercase');
    expect(html).toContain('xlsx');
  });

  it('middle-truncates long filenames, keeping the extension tail', () => {
    const long = render({
      uploads: [{ ...UPLOADS[0], id: 'u9', filename: 'a-very-long-filename-that-keeps-going-and-going.pdf' }],
      generated: [],
      status: 'ready',
    });
    // Visible text is the middle-truncated form; the full name survives only
    // in the title= hover tooltip.
    expect(long).toContain('a-very-long-filena…ing-and-going.pdf');
    expect(long).toContain('title="a-very-long-filename-that-keeps-going-and-going.pdf"');
  });
});

describe('ChatFilesSectionView — B1: scripting-capable essences get NO Preview', () => {
  // Review finding B1: openInline re-serves bytes from a blob: URL, stripping
  // the backend's CSP sandbox header — Preview of stored html/svg would run
  // scripts in the app origin. canPreview must mirror the backend's
  // needsInlineSandbox gate (on the essence); Download stays available.
  const SCRIPTING: ChatFileMeta[] = [
    { id: 's1', filename: 'payload.html', mimeType: 'text/html', sizeBytes: 128, createdAt: twoDaysAgo, uploadId: null },
    { id: 's2', filename: 'vector.svg', mimeType: 'image/svg+xml', sizeBytes: 256, createdAt: twoDaysAgo, uploadId: null },
    // Parameterized + case variants must not slip past the essence gate.
    { id: 's3', filename: 'report.html', mimeType: 'Text/HTML; charset=utf-8', sizeBytes: 128, createdAt: twoDaysAgo, uploadId: null },
    { id: 's4', filename: 'icon.svg', mimeType: 'IMAGE/SVG+XML', sizeBytes: 256, createdAt: twoDaysAgo, uploadId: null },
  ];
  const html = render({ uploads: SCRIPTING, generated: [], status: 'ready' });

  it('renders every row (Download stays available for these types)', () => {
    expect(html).toContain('payload.html');
    expect(html).toContain('vector.svg');
    expect(html).toContain('report.html');
    expect(html).toContain('icon.svg');
    expect(html.match(/Download file/g) || []).toHaveLength(4);
  });

  it('html + svg rows render NO Preview button (the exact B1 scenario)', () => {
    expect(html.match(/Preview/g) || []).toHaveLength(0);
  });

  it.each(['Text/HTML; charset=utf-8', 'IMAGE/SVG+XML', 'text/html', 'image/svg+xml'])(
    'essence gate: %s renders Download but no Preview',
    (mimeType) => {
      const row = render({
        uploads: [{ id: 'sx', filename: 'row.bin', mimeType, sizeBytes: 1, createdAt: twoDaysAgo, uploadId: null }],
        generated: [],
        status: 'ready',
      });
      expect(row).toContain('row.bin');
      expect(row).toContain('Download file');
      expect(row).not.toContain('Preview');
    },
  );
});

describe('ChatFilesSectionView — generated IMAGE rows (generate_image, 2026-09-24)', () => {
  const IMAGE: GeneratedFileMeta = {
    id: 'g2',
    filename: 'image-20260924-red-fox.png',
    format: 'png',
    mimeType: 'image/png',
    size: 700 * 1024,
    createdAt: twoDaysAgo,
    chatId: 'chat-1',
  };

  it('a png generated row renders the authed thumbnail placeholder, a Preview action and Download', () => {
    const html = render({ uploads: [], generated: [IMAGE], status: 'ready' });
    expect(html).toContain('image-20260924-red-fox.png');
    // The same size-10 authed thumbnail UploadRow renders (effect-upgraded in
    // the browser; SSR shows the loading placeholder).
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html).toContain('aria-label="image-20260924-red-fox.png"');
    expect(html.match(/Preview/g) || []).toHaveLength(1);
    expect(html.match(/Download file/g) || []).toHaveLength(1);
    // Format badge still shows the sniffed extension.
    expect(html).toContain('png');
    expect(html).toContain('700.0 KB');
    // The lightbox mounts only after a click — never in static markup.
    expect(html).not.toContain('data-authed-image-lightbox');
  });

  it.each(['jpg', 'jpeg', 'webp'])('a %s generated row is an image row too (thumbnail + Preview)', (format) => {
    const mime = format === 'webp' ? 'image/webp' : 'image/jpeg';
    const html = render({ uploads: [], generated: [{ ...IMAGE, id: `g-${format}`, filename: `pic.${format}`, format, mimeType: mime }], status: 'ready' });
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html.match(/Preview/g) || []).toHaveLength(1);
  });

  it('document rows (xlsx) keep the type icon and get NO Preview (regression)', () => {
    const html = render({ uploads: [], generated: GENERATED, status: 'ready' });
    expect(html).not.toContain('data-authed-file-image');
    expect(html.match(/Preview/g) || []).toHaveLength(0);
    expect(html.match(/Download file/g) || []).toHaveLength(1);
  });

  it('the empty state mentions images', () => {
    const html = render({ uploads: [], generated: [], status: 'ready' });
    expect(html).toContain('documents, code, spreadsheets, images');
  });
});

describe('ChatFilesSectionView — empty / error / idle / loading states', () => {
  it('renders ONE honest empty state (not one per kind)', () => {
    const html = render({ uploads: [], generated: [], status: 'ready' });
    expect(html.match(/No files yet/g) || []).toHaveLength(1);
    expect(html).not.toContain('data-files-count'); // no "0" over the empty state
    expect(html).not.toContain('No uploads yet');
    expect(html).not.toContain('Nothing created here yet');
  });

  it('the empty state offers New file only when the host passes it', () => {
    expect(render({ uploads: [], generated: [], status: 'ready' })).not.toContain('New file');
    expect(render({ uploads: [], generated: [], status: 'ready', onNewFile: () => {} })).toContain('New file');
  });

  it('renders the error state with a retry affordance (never an empty state)', () => {
    const html = render({ uploads: [], generated: [], status: 'error', onRetry: () => {} });
    expect(html).toContain('load this chat');
    expect(html).toContain('Retry');
    expect(html).not.toContain('No files yet');
  });

  it('renders the idle (no chat) state', () => {
    const html = render({ uploads: [], generated: [], status: 'idle' });
    expect(html).toContain('Open a chat to see its files');
  });

  it('renders the loading spinner state', () => {
    const html = render({ uploads: [], generated: [], status: 'loading' });
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('No files yet');
  });
});

describe('ChatFilesSectionView — documents are files (2026-10-07)', () => {
  const newer = new Date(Date.now() - 60_000).toISOString();
  const DOCS = [
    { id: 'c1', title: 'Launch plan', type: 'document' as const, content: '# Plan', version: 1, updatedAt: newer },
    { id: 'c2', title: 'Script', type: 'code' as const, language: 'python', content: 'print(1)', version: 1, updatedAt: twoDaysAgo },
    // Read-only worktree previews are never listed.
    { id: 'wt:x', title: 'preview', type: 'code' as const, content: '', version: 1, readOnly: true },
  ];
  const html = render({ uploads: UPLOADS, generated: GENERATED, docs: DOCS, status: 'ready', onOpenDoc: () => {} });

  it('lists documents in the same list as uploads + generated files, newest first', () => {
    expect(html.match(/<ul /g) || []).toHaveLength(1);
    expect(html).toContain('Launch plan');
    expect(html).toContain('Script');
    expect(html).not.toContain('>preview<');
    expect(html).toContain('6 files'); // 3 uploads + 1 generated + 2 documents
    expect(html.indexOf('Launch plan')).toBeLessThan(html.indexOf('quarterly-report'));
  });

  it('a document row names its file type and opens on click', () => {
    expect(html).toContain('Open launch-plan.md');
    expect(html).toContain('>py</span>');
  });
});
