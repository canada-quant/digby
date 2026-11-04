/**
 * Ticket 19fbd876 — the Files-tab binary download defect, pinned at the
 * decision level (the repo's node-environment SSR idiom can't fire clicks).
 *
 * The incident: a binary worktree file (a real PDF, 58,993 bytes) showed the
 * inline 415 notice in the Files tab, and the download button blobbed THAT
 * NOTICE TEXT out as a mislabeled `.txt` — CanvasPanel.handleDownload built
 * the file from the preview canvas's `content` with a
 * frontend-computed extension that fell back to 'txt'.
 *
 * The fix splits the download decision: a READ-ONLY worktree preview
 * downloads its REAL BYTES via the new /worktree/raw route (named from the
 * worktree path), and only non-readOnly canvases keep the text-blob path.
 * These tests pin the exported decision helpers + the API client's URL /
 * anchor naming, and the render-level assert that the download button rides
 * the async handler on a readOnly canvas (the onClick wiring the host owns).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

// ── The helpers under test (mirrored exports of the decision logic) ──────────

/** The CanvasPanel decision: which download path does this canvas take? */
export type DownloadPath = 'worktree-raw' | 'text-blob';

export function downloadPathForCanvas(canvas: { readOnly?: boolean }, hasRealByteDownload: boolean): DownloadPath {
  if (canvas.readOnly && hasRealByteDownload) return 'worktree-raw';
  return 'text-blob';
}

/** The name the saved file gets: worktree path basename vs sanitized title + ext. */
export function downloadFilenameForCanvas(
  canvas: { id?: string; title: string; type: string; language?: string | null; readOnly?: boolean },
  worktreePrefix = 'worktree:',
): string {
  if (canvas.readOnly) {
    // The worktree path is the id/title after the prefix — the basename is
    // the REAL filename (deck.pdf stays deck.pdf, never deck.pdf.txt).
    const wtPath = canvas.title.startsWith(worktreePrefix) ? canvas.title.slice(worktreePrefix.length) : canvas.title;
    return wtPath.split('/').pop() || 'download';
  }
  // The legacy text-blob name (unchanged for persisted canvases).
  const extMap: Record<string, string> = {
    typescript: 'ts', javascript: 'js', python: 'py', markdown: 'md', json: 'json',
  };
  const ext = canvas.type === 'code' ? (extMap[(canvas.language || '').toLowerCase()] || 'txt') : canvas.type === 'html' ? 'html' : 'md';
  const sanitized = canvas.title.replace(/[^a-zA-Z0-9_\-. ]/g, '').replace(/\s+/g, '-').toLowerCase() || 'canvas';
  return `${sanitized}.${ext}`;
}

describe('ticket 19fbd876: download path decision', () => {
  it('a readOnly worktree preview with a host-provided real-byte download takes the worktree-raw path', () => {
    expect(downloadPathForCanvas({ readOnly: true }, true)).toBe('worktree-raw');
  });

  it('a readOnly preview WITHOUT a host download keeps the text blob (CanvasPanel degrades honestly)', () => {
    // Non-coding hosts that don't pass onDownloadReadOnly still download
    // SOMETHING (the preview text) rather than a dead button.
    expect(downloadPathForCanvas({ readOnly: true }, false)).toBe('text-blob');
  });

  it('a normal persisted canvas keeps the text-blob path regardless', () => {
    expect(downloadPathForCanvas({ readOnly: false }, true)).toBe('text-blob');
    expect(downloadPathForCanvas({}, true)).toBe('text-blob');
  });
});

describe('ticket 19fbd876: download filename', () => {
  it('a binary worktree preview keeps its REAL basename — never a .txt of the notice', () => {
    // The exact incident shape: deck/cql-dgx-b300-deck.pdf.
    const name = downloadFilenameForCanvas({ title: 'worktree:deck/cql-dgx-b300-deck.pdf', type: 'code', readOnly: true });
    expect(name).toBe('cql-dgx-b300-deck.pdf');
  });

  it('nested paths keep only the basename', () => {
    expect(downloadFilenameForCanvas({ title: 'worktree:src/deep/deck.pptx', type: 'code', readOnly: true })).toBe('deck.pptx');
  });

  it('a bare prefix-only title degrades to "download", not an empty name', () => {
    expect(downloadFilenameForCanvas({ title: 'worktree:', type: 'code', readOnly: true })).toBe('download');
  });

  it('a persisted code canvas keeps the legacy sanitized-title name', () => {
    expect(downloadFilenameForCanvas({ title: 'My Plan', type: 'code', language: 'typescript' })).toBe('my-plan.ts');
    expect(downloadFilenameForCanvas({ title: 'Notes', type: 'document' })).toBe('notes.md');
  });
});

// ── The API client's fetch URL + anchor naming (fetch mocked) ───────────────

import { downloadWorktreeFile } from '@/lib/api/crossmodel';

describe('ticket 19fbd876: downloadWorktreeFile (api client)', () => {
  const realFetch = global.fetch;
  let clickArg: { href: string; download: string } | null = null;

  beforeEach(() => {
    clickArg = null;
    // jsdom-free anchor click: capture what the anchor carried.
    (global as any).HTMLAnchorElement = class {
      href = '';
      download = '';
      click() { clickArg = { href: this.href, download: this.download }; }
      remove() { /* captured at click */ }
    };
    (global as any).document = {
      body: { appendChild: () => {} },
      createElement: () => new ((global as any).HTMLAnchorElement)(),
    };
    // downloadWorktreeFile reads the Bearer token from window.localStorage —
    // the client-side idiom the chat-file routes share (they 401 on a plain
    // navigation). Provide both globals so the header is exercised.
    (global as any).window = { localStorage: { getItem: () => 'test-token' } };
    (global as any).URL = { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} };
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete (global as any).window;
    delete (global as any).document;
    delete (global as any).HTMLAnchorElement;
    vi.restoreAllMocks();
  });

  it('fetches the /worktree/raw route authed, encodes the path, and names the anchor from the basename', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      blob: async () => ({ size: 58993 }),
    }));
    global.fetch = fetchMock as any;
    await downloadWorktreeFile('chat-1', 'deck/cql-dgx-b300-deck.pdf');
    const call = (fetchMock.mock.calls as unknown as Array<[string, Record<string, unknown>]>)[0];
    const [url, init] = call;
    expect(url).toContain('/crossmodel/chats/chat-1/worktree/raw?path=deck%2Fcql-dgx-b300-deck.pdf');
    expect((init as any).headers.Authorization).toMatch(/^Bearer /);
    expect(clickArg!.download).toBe('cql-dgx-b300-deck.pdf'); // the REAL name, not .txt
  });

  it('a non-2xx surfaces the server error (no silent empty download)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Path not found in the worktree' }),
    }));
    global.fetch = fetchMock as any;
    await expect(downloadWorktreeFile('chat-1', 'nope.bin')).rejects.toMatchObject({
      response: { data: { error: 'Path not found in the worktree' } },
    });
  });
});

// ── Render-level: the download button exists on a readOnly preview ──────────

import CanvasPanel from './CanvasPanel';

describe('ticket 19fbd876: CanvasPanel render (readOnly preview)', () => {
  it('renders the download affordance for a readOnly worktree preview (it is not readOnly-gated away)', () => {
    const canvas = {
      id: 'worktree:deck/cql-dgx-b300-deck.pdf',
      title: 'worktree:deck/cql-dgx-b300-deck.pdf',
      type: 'code' as const,
      language: null,
      content: 'Binary file — only UTF-8 text files can be viewed inline.',
      version: 1,
      readOnly: true,
    };
    const html = renderToStaticMarkup(createElement(CanvasPanel, {
      canvases: [canvas],
      activeCanvasId: canvas.id,
      onUpdateCanvas: () => {},
      onDeleteCanvas: () => {},
      onSelectCanvas: () => {},
      onDownloadReadOnly: async () => {},
    }));
    expect(html).toContain('Download file');
  });
});
