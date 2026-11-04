/**
 * Tests for the message file-link embeds (ticket 57ef1b9f PR3).
 *
 * Two layers, same idiom as markdown-content.test.tsx / ChatFilesSection.test.tsx:
 *   - PURE decisions unit-tested directly: parseFileLinkHref (route-shape
 *     recognizer), isBlobRenderableImage (the B1 mime gate), isInlineImageUrl
 *     (the bare image-URL extension gate), and fetchChatFileBlob (authed byte
 *     fetch with an injected mock fetch — the interactive effect path can't
 *     run under the node-environment SSR idiom).
 *   - SSR markup via renderToStaticMarkup: recognized links render as cards,
 *     unrecognized links/images render byte-identically to before, and a
 *     chat-file image src renders the assertable loading placeholder (the
 *     effect only upgrades it to an <img> in the browser).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { MarkdownContent } from './markdown-content';
import {
  AudioFilePlayer,
  AuthedFileImage,
  FileLinkCard,
  fetchChatFileBlob,
  imageActionsFor,
  isBlobPlayableAudio,
  isBlobRenderableImage,
  isInlineImageUrl,
  parseFileLinkHref,
  rewriteFileSchemeLinks,
} from './file-link-card';

const GEN_ID = '11111111-2222-3333-4444-555555555555';
const FILE_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const render = (md: string) =>
  renderToStaticMarkup(createElement(MarkdownContent, null, md));

describe('rewriteFileSchemeLinks — bare file: scheme defense (ticket 8db4c18e)', () => {
  it('rewrites a bare file:<uuid> destination to the generated-file download route', () => {
    expect(rewriteFileSchemeLinks(`[Download x.csv](file:${GEN_ID})`))
      .toBe(`[Download x.csv](/api/crossmodel/generated-files/${GEN_ID}/download)`);
  });

  it('tolerates the file:// authority form and scheme case', () => {
    expect(rewriteFileSchemeLinks(`[x](file://${GEN_ID})`))
      .toBe(`[x](/api/crossmodel/generated-files/${GEN_ID}/download)`);
    expect(rewriteFileSchemeLinks(`[x](FILE://${GEN_ID})`))
      .toBe(`[x](/api/crossmodel/generated-files/${GEN_ID}/download)`);
  });

  it('tolerates whitespace inside the parens', () => {
    expect(rewriteFileSchemeLinks(`[x]( file:${GEN_ID} )`))
      .toBe(`[x](/api/crossmodel/generated-files/${GEN_ID}/download)`);
  });

  it('leaves non-uuid file: values alone (no fabricated routes)', () => {
    expect(rewriteFileSchemeLinks('[x](file:///etc/passwd)')).toBe('[x](file:///etc/passwd)');
    expect(rewriteFileSchemeLinks('[x](file:abc)')).toBe('[x](file:abc)');
    // A uuid followed by more path is not the bare shape — untouched.
    expect(rewriteFileSchemeLinks(`[x](file://${GEN_ID}/extra)`)).toBe(`[x](file://${GEN_ID}/extra)`);
  });

  it('leaves http links and existing file routes untouched', () => {
    const http = '[Example](https://example.com/page)';
    expect(rewriteFileSchemeLinks(http)).toBe(http);
    const generated = `[report](/api/crossmodel/generated-files/${GEN_ID}/download)`;
    expect(rewriteFileSchemeLinks(generated)).toBe(generated);
    const chatFile = `[scan](/api/crossmodel/files/${FILE_ID}/inline)`;
    expect(rewriteFileSchemeLinks(chatFile)).toBe(chatFile);
    // An http URL that merely contains "file:" later in the path is untouched.
    const tricky = '[x](https://example.com/redirect?to=file:abc)';
    expect(rewriteFileSchemeLinks(tricky)).toBe(tricky);
  });

  it('is idempotent and passes through content with no file: scheme', () => {
    const once = rewriteFileSchemeLinks(`[x](file:${GEN_ID})`);
    expect(rewriteFileSchemeLinks(once)).toBe(once);
    expect(rewriteFileSchemeLinks('plain text, no links')).toBe('plain text, no links');
    expect(rewriteFileSchemeLinks('')).toBe('');
  });
});

describe('rewriteFileSchemeLinks — residual gap coverage (ticket a2325600)', () => {
  it('rewrites an angle-bracket destination [x](<file:<uuid>>)', () => {
    expect(rewriteFileSchemeLinks(`[x](<file:${GEN_ID}>)`))
      .toBe(`[x](/api/crossmodel/generated-files/${GEN_ID}/download)`);
  });

  it('rewrites a titled destination [x](file:<uuid> "t") (double, single, and paren title forms)', () => {
    expect(rewriteFileSchemeLinks(`[x](file:${GEN_ID} "Plan")`))
      .toBe(`[x](/api/crossmodel/generated-files/${GEN_ID}/download)`);
    expect(rewriteFileSchemeLinks(`[x](file:${GEN_ID} 'Plan')`))
      .toBe(`[x](/api/crossmodel/generated-files/${GEN_ID}/download)`);
    expect(rewriteFileSchemeLinks(`[x](file:${GEN_ID} (Plan))`))
      .toBe(`[x](/api/crossmodel/generated-files/${GEN_ID}/download)`);
  });

  it('rewrites a reference-style link def [x]: file:<uuid>, preserving an optional title', () => {
    expect(rewriteFileSchemeLinks(`[x]: file:${GEN_ID}\n\nSee [x].`))
      .toBe(`[x]: /api/crossmodel/generated-files/${GEN_ID}/download\n\nSee [x].`);
    expect(rewriteFileSchemeLinks(`[x]: file:${GEN_ID} "Plan"\n\nSee [x].`))
      .toBe(`[x]: /api/crossmodel/generated-files/${GEN_ID}/download "Plan"\n\nSee [x].`);
    // Angle-bracket ref-def destination too.
    expect(rewriteFileSchemeLinks(`[x]: <file:${GEN_ID}>`))
      .toBe(`[x]: /api/crossmodel/generated-files/${GEN_ID}/download`);
  });

  it('does NOT rewrite a file: link inside a fenced code block (displayed code keeps its text)', () => {
    const fenced = `Example:\n\n\`\`\`markdown\n[x](file:${GEN_ID})\n\`\`\``;
    expect(rewriteFileSchemeLinks(fenced)).toBe(fenced);
  });

  it('recognizes a CRLF closing fence — a link AFTER the block still rewrites (reviewer nit 1)', () => {
    // Without \r? in the close regex, a CRLF fence looks unclosed and swallows
    // the rest of the message into "code", suppressing later rewrites.
    const md = `\`\`\`js\r\n[x](file:${GEN_ID})\r\n\`\`\`\r\n[y](file:${GEN_ID})`;
    expect(rewriteFileSchemeLinks(md))
      .toBe(`\`\`\`js\r\n[x](file:${GEN_ID})\r\n\`\`\`\r\n[y](/api/crossmodel/generated-files/${GEN_ID}/download)`);
  });

  it('does NOT rewrite a file: link inside an inline code span', () => {
    const inline = `Use \`[x](file:${GEN_ID})\` literally.`;
    expect(rewriteFileSchemeLinks(inline)).toBe(inline);
    // …but the same link OUTSIDE the span still rewrites on the same line.
    expect(rewriteFileSchemeLinks(`\`[x](file:${GEN_ID})\` and [y](file:${GEN_ID})`))
      .toBe(`\`[x](file:${GEN_ID})\` and [y](/api/crossmodel/generated-files/${GEN_ID}/download)`);
  });

  it('SECURITY NEGATIVE: injection-shaped destinations pass through UNREWRITTEN', () => {
    // Quote hard against the uuid (no whitespace) — not a valid CommonMark
    // title; must NOT match (a rewrite here would smuggle attributes into a
    // rendered anchor). react-markdown's defaultUrlTransform still blanks it.
    const inject = `[x](file:${GEN_ID}" onmouseover=alert(1))`;
    expect(rewriteFileSchemeLinks(inject)).toBe(inject);
    const injectRef = `[x]: file:${GEN_ID}" onmouseover=alert(1)`;
    expect(rewriteFileSchemeLinks(injectRef)).toBe(injectRef);
  });

  it('is idempotent on every new shape', () => {
    for (const md of [
      `[x](<file:${GEN_ID}>)`,
      `[x](file:${GEN_ID} "Plan")`,
      `[x]: file:${GEN_ID} "Plan"\n\nSee [x].`,
      `Use \`[x](file:${GEN_ID})\` literally.`,
    ]) {
      const once = rewriteFileSchemeLinks(md);
      expect(rewriteFileSchemeLinks(once)).toBe(once);
    }
  });
});

describe('parseFileLinkHref — route-shape recognizer', () => {
  it('recognizes the generated-file download route (what create_document renders)', () => {
    expect(parseFileLinkHref(`/api/crossmodel/generated-files/${GEN_ID}/download`))
      .toEqual({ kind: 'generated', id: GEN_ID });
  });

  it('recognizes the generated-file INLINE route (what generate_image persists, 2026-09-24)', () => {
    expect(parseFileLinkHref(`/api/crossmodel/generated-files/${GEN_ID}/inline`))
      .toEqual({ kind: 'generated', id: GEN_ID, route: 'inline' });
  });

  it('recognizes the chat-file download + inline routes', () => {
    expect(parseFileLinkHref(`/api/crossmodel/files/${FILE_ID}/download`))
      .toEqual({ kind: 'chat-file', id: FILE_ID, route: 'download' });
    expect(parseFileLinkHref(`/api/crossmodel/files/${FILE_ID}/inline`))
      .toEqual({ kind: 'chat-file', id: FILE_ID, route: 'inline' });
  });

  it('ignores query strings (?token=…) and trailing slashes', () => {
    expect(parseFileLinkHref(`/api/crossmodel/generated-files/${GEN_ID}/download?token=abc123`))
      .toEqual({ kind: 'generated', id: GEN_ID });
    expect(parseFileLinkHref(`/api/crossmodel/files/${FILE_ID}/inline/#frag`))
      .toEqual({ kind: 'chat-file', id: FILE_ID, route: 'inline' });
  });

  it('accepts absolute URLs on the configured API origin only', () => {
    // Default API base in tests: http://localhost:4000/api (same fallback as
    // chatFilesApi) — an absolute link on that origin is still OUR api.
    expect(parseFileLinkHref(`http://localhost:4000/api/crossmodel/files/${FILE_ID}/inline`))
      .toEqual({ kind: 'chat-file', id: FILE_ID, route: 'inline' });
    expect(parseFileLinkHref(`https://evil.example/api/crossmodel/files/${FILE_ID}/inline`))
      .toBeNull();
  });

  it('rejects non-matching shapes', () => {
    expect(parseFileLinkHref('https://example.com/report.pdf')).toBeNull();
    expect(parseFileLinkHref('/api/crossmodel/files/not-a-uuid/inline')).toBeNull();
    expect(parseFileLinkHref(`/api/crossmodel/files/${FILE_ID}/delete`)).toBeNull();
    expect(parseFileLinkHref(`/api/crossmodel/generated-files/${GEN_ID}/delete`)).toBeNull();
    expect(parseFileLinkHref('javascript:alert(1)')).toBeNull();
    expect(parseFileLinkHref('')).toBeNull();
    expect(parseFileLinkHref(undefined)).toBeNull();
  });
});

describe('isInlineImageUrl — the bare image-URL extension gate (c6e8edda follow-up)', () => {
  it.each([
    'https://example.com/chart.png',
    'https://example.com/PHOTO.JPG',                 // case-insensitive
    'https://cdn.example.com/a/b/pic.jpeg?w=640#x',  // query + hash stripped
    'https://example.com/x.webp',
    'https://example.com/x.gif',
    'https://example.com/x.avif',
    '/relative/path/x.png',                          // same-origin relative path
    'images/x.png?size=2x',
  ])('promotes an image pathname: %s', (href) => expect(isInlineImageUrl(href)).toBe(true));

  it.each([
    'https://example.com/icon.svg',      // scripting-capable — the B1 family
    'https://example.com/report.pdf',
    'https://example.com/page',
    'https://example.com/x.png.exe',     // the LAST extension decides
    'https://example.com/x.png/',        // trailing slash — no terminal ext
    'https://example.com/img?f=x.png',   // ext in the QUERY, not the pathname
    'javascript:alert(1)',
    '',
  ])('never promotes: %s', (href) => expect(isInlineImageUrl(href)).toBe(false));

  it('null/undefined/malformed hrefs never promote', () => {
    expect(isInlineImageUrl(null)).toBe(false);
    expect(isInlineImageUrl(undefined)).toBe(false);
    expect(isInlineImageUrl('http://')).toBe(false);
  });
});

describe('isBlobRenderableImage — the B1 inline mime gate', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'IMAGE/PNG', 'image/gif; charset=binary'])(
    'renders raster image essence: %s',
    (mime) => expect(isBlobRenderableImage(mime)).toBe(true),
  );

  it.each([
    'image/svg+xml',                    // scripting-capable — the exact B1 case
    'image/svg+xml; charset=utf-8',     // parameterized variant must not slip past
    'IMAGE/SVG+XML',                    // case variant
    'text/html',
    'application/pdf',
    'text/plain',
    'application/octet-stream',
    '',
  ])('never blob-renders: %s', (mime) => expect(isBlobRenderableImage(mime)).toBe(false));
});

describe('fetchChatFileBlob — authed byte fetch (mock fetch)', () => {
  const mockFetch = (impl: () => Promise<Partial<Response>>) =>
    impl as unknown as typeof fetch;

  it('returns the blob on a 200 (Bearer header sent when a token exists)', async () => {
    const blob = new Blob(['png-bytes'], { type: 'image/png' });
    const res = await fetchChatFileBlob(FILE_ID, 'inline', mockFetch(async () => ({ ok: true, blob: async () => blob })));
    expect(res).toBe(blob);
  });

  it('returns null on http errors (401/404/415…)', async () => {
    const res = await fetchChatFileBlob(FILE_ID, 'download', mockFetch(async () => ({ ok: false, status: 401 })));
    expect(res).toBeNull();
  });

  it('returns null on network failure (never throws into the renderer)', async () => {
    const res = await fetchChatFileBlob(FILE_ID, 'inline', mockFetch(async () => { throw new Error('network down'); }));
    expect(res).toBeNull();
  });

  it('B1 composition: a fetched svg/html blob fails the render gate → card fallback', async () => {
    // The decision AuthedFileImage makes with a successful-but-dangerous fetch.
    for (const type of ['image/svg+xml', 'text/html', 'application/pdf']) {
      const blob = new Blob(['x'], { type });
      const fetched = await fetchChatFileBlob(FILE_ID, 'inline', mockFetch(async () => ({ ok: true, blob: async () => blob })));
      expect(fetched).not.toBeNull();
      expect(isBlobRenderableImage(fetched!.type)).toBe(false);
    }
    const good = new Blob(['x'], { type: 'image/png' });
    const fetched = await fetchChatFileBlob(FILE_ID, 'inline', mockFetch(async () => ({ ok: true, blob: async () => good })));
    expect(isBlobRenderableImage(fetched!.type)).toBe(true);
  });
});

describe('MarkdownContent — file links render as cards', () => {
  it('a generated-file download link renders a card with filename + download affordance', () => {
    const html = render(`Here is your file: [report.xlsx](/api/crossmodel/generated-files/${GEN_ID}/download)`);
    expect(html).toContain('data-file-link-card="generated"');
    expect(html).toContain('report.xlsx');
    expect(html).toContain('aria-label="Download report.xlsx"');
    // The bare route is gone — no clickable unauthenticated navigation remains.
    expect(html).not.toContain(`href="/api/crossmodel/generated-files/`);
  });

  it('a chat-file DOWNLOAD link renders a card', () => {
    const html = render(`[scan.pdf](/api/crossmodel/files/${FILE_ID}/download)`);
    expect(html).toContain('data-file-link-card="chat-file"');
    expect(html).toContain('scan.pdf');
    expect(html).toContain('aria-label="Download scan.pdf"');
  });

  it('a chat-file INLINE link renders the authed inline image, not a card (c6e8edda follow-up)', () => {
    // An /inline href is the model's "show this here" signal — the link now
    // takes the same authed + B1-gated embed as the ![] form. SSR shows the
    // loading placeholder; a non-image blob behind the route still degrades
    // to the FileLinkCard in the browser (the B1 gate is AuthedFileImage's).
    const html = render(`[floor plan](/api/crossmodel/files/${FILE_ID}/inline)`);
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html).toContain('aria-label="floor plan"');
    expect(html).not.toContain('data-file-link-card');
    expect(html).not.toContain(`href="/api/crossmodel/files/`);
  });

  it('a raw-URL link text falls back to a generic label instead of echoing the path', () => {
    const path = `/api/crossmodel/generated-files/${GEN_ID}/download`;
    const html = render(`[${path}](${path})`);
    expect(html).toContain('data-file-link-card="generated"');
    expect(html).toContain('aria-label="Download file"');
  });

  it('REGRESSION (ticket 8db4c18e): a bare file:<uuid> link renders a working card, not an app-reloading anchor', () => {
    // The user's exact report: the model emitted the download as
    // [Download x.csv](file:<uuid>) — urlTransform blanked the scheme and the
    // href="" target=_blank anchor reloaded the app. The pre-render rewrite
    // routes it to the FileLinkCard path instead.
    const html = render(`Here you go: [Download x.csv](file:${GEN_ID})`);
    expect(html).toContain('data-file-link-card="generated"');
    expect(html).toContain('Download x.csv');
    expect(html).not.toContain('href="file:');
  });

  it('the file:// authority form also renders as a card', () => {
    const html = render(`[report.pdf](file://${GEN_ID})`);
    expect(html).toContain('data-file-link-card="generated"');
    expect(html).toContain('report.pdf');
  });

  it('a non-uuid file: destination is NOT rewritten — no card, no fabricated route', () => {
    const html = render('[x](file:///etc/passwd)');
    expect(html).not.toContain('data-file-link-card');
    expect(html).not.toContain('/api/crossmodel/generated-files');
  });

  it('ordinary external links render unchanged', () => {
    const html = render('[Example](https://example.com/page)');
    expect(html).toContain('<a href="https://example.com/page" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('Example');
    expect(html).not.toContain('data-file-link-card');
  });

  it('a foreign-origin absolute URL that mimics the route shape stays a plain link', () => {
    const html = render(`[x](https://evil.example/api/crossmodel/files/${FILE_ID}/inline)`);
    expect(html).toContain('<a href="https://evil.example/api/crossmodel/files/');
    expect(html).not.toContain('data-file-link-card');
  });
});

describe('MarkdownContent — images', () => {
  it('an ordinary https image renders unchanged', () => {
    const html = render('![cat](https://example.com/cat.png)');
    expect(html).toContain('<img src="https://example.com/cat.png" alt="cat"');
    expect(html).not.toContain('data-authed-file-image');
  });

  it('a chat-file inline image renders the loading placeholder, never the raw route as <img> src', () => {
    const html = render(`![floor plan](/api/crossmodel/files/${FILE_ID}/inline)`);
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html).toContain('min-h-24'); // reserved height — no layout jump on resolve
    expect(html).not.toContain(`<img src="/api/crossmodel/files/`);
  });

  it('a chat-file download route as image src also goes through the authed embed', () => {
    const html = render(`![photo](/api/crossmodel/files/${FILE_ID}/download)`);
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html).not.toContain(`<img src="/api/crossmodel/files/`);
  });
});

describe('AuthedFileImage / FileLinkCard — direct SSR states', () => {
  it('AuthedFileImage SSRs the loading placeholder (effects never run server-side)', () => {
    const html = renderToStaticMarkup(
      createElement(AuthedFileImage, { target: { kind: 'chat-file', id: FILE_ID, route: 'inline' }, alt: 'diagram' }),
    );
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html).toContain('aria-label="diagram"');
  });

  it('FileLinkCard carries the filename in text + tooltip and a focusable download button', () => {
    const html = renderToStaticMarkup(
      createElement(FileLinkCard, { filename: 'notes.md', target: { kind: 'generated', id: GEN_ID } }),
    );
    expect(html).toContain('title="notes.md"');
    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Download notes.md"');
  });
});

describe('AuthedFileImage — click-to-expand wiring (ticket c6e8edda)', () => {
  // The ready-state zoom button + lightbox live behind the fetch effect,
  // which never runs under the SSR idiom — what IS assertable here: the
  // refactor left the SSR contract untouched, and the blob the lightbox
  // would show still comes through the same authed + B1-gated fetch.
  it('the SSR placeholder is unchanged by the expand refactor (className prop accepted)', () => {
    const html = renderToStaticMarkup(
      createElement(AuthedFileImage, {
        target: { kind: 'chat-file', id: FILE_ID, route: 'inline' },
        alt: 'diagram',
        className: 'max-h-48 max-w-full rounded-lg object-contain',
      }),
    );
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html).toContain('aria-label="diagram"');
    // No eager dialog markup — the lightbox mounts only after a real click.
    expect(html).not.toContain('role="dialog"');
  });

  it('the lightbox src can only be a B1-passing blob (same fetch/blob pattern as the effect)', async () => {
    // fetchChatFileBlob + isBlobRenderableImage is exactly the composition
    // the effect runs before the zoom button ever exists — a non-image blob
    // falls back to the card and never reaches the lightbox.
    const mockFetch = (impl: () => Promise<Partial<Response>>) =>
      impl as unknown as typeof fetch;
    const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    const fetched = await fetchChatFileBlob(FILE_ID, 'inline', mockFetch(async () => ({ ok: true, blob: async () => svg })));
    expect(fetched).not.toBeNull();
    expect(isBlobRenderableImage(fetched!.type)).toBe(false);
  });
});

// Ticket 390b6767 — the ready-state action row (Download / View full size).
// The row lives behind the fetch effect (never runs under this node/SSR
// idiom), so its decisions are pinned two ways: the PURE imageActionsFor()
// unit-tested directly, and a source pin of the wiring (the repo's
// user-message-copy / use-voice-composer readFileSync idiom) asserting the
// ready state renders the row and Download is dispatched by kind.
describe('imageActionsFor — action-row decisions (ticket 390b6767)', () => {
  it('derives the download filename from a USABLE alt text when present, else id + fetched mime', () => {
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, 'qwen_v1_test.png', 'image/png'))
      .toMatchObject({ filename: 'qwen_v1_test.png', downloadApi: 'chat-file' });
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, undefined, 'image/png'))
      .toMatchObject({ filename: `image-${FILE_ID.slice(0, 8)}.png`, downloadApi: 'chat-file' });
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, '   ', 'image/jpeg'))
      .toMatchObject({ filename: `image-${FILE_ID.slice(0, 8)}.jpg` });
    expect(imageActionsFor({ kind: 'generated', id: GEN_ID, route: 'inline' }, undefined, 'image/webp'))
      .toMatchObject({ filename: `image-${GEN_ID.slice(0, 8)}.webp`, downloadApi: 'generated' });
  });

  it('an extension-less alt falls back to the derived id+ext name (a browser cannot open "photo")', () => {
    // Review finding: model-authored alt prose like "a chart of the results"
    // is not a filename — only an alt that already looks like a file name wins.
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, 'a chart of the results', 'image/png').filename)
      .toBe(`image-${FILE_ID.slice(0, 8)}.png`);
  });

  it('sanitizes a hostile alt: path separators, newlines, control chars, absurd length', () => {
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, '../../etc/passwd.png', 'image/png').filename)
      .toBe('..-..-etc-passwd.png');
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, 'line1.png\nline2', 'image/png').filename)
      .toBe('line1.png');
    const long = `${'x'.repeat(200)}.png`;
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, long, 'image/png').filename.length)
      .toBeLessThanOrEqual(84); // 80-char cap + '.png'
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, '   ', 'image/png').filename)
      .toBe(`image-${FILE_ID.slice(0, 8)}.png`);
  });

  it('an unknown/absent mime falls back to .png (never a broken download name)', () => {
    expect(imageActionsFor({ kind: 'generated', id: GEN_ID, route: 'inline' }).filename)
      .toBe(`image-${GEN_ID.slice(0, 8)}.png`);
    expect(imageActionsFor({ kind: 'generated', id: GEN_ID, route: 'inline' }, undefined, 'application/octet-stream').filename)
      .toBe(`image-${GEN_ID.slice(0, 8)}.png`);
    // A parameterized/case-variant fetched mime keys on its essence.
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, undefined, 'IMAGE/JPEG; charset=binary').filename)
      .toBe(`image-${FILE_ID.slice(0, 8)}.jpg`);
  });

  it('exposes the accessible labels the buttons render', () => {
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, 'shot.png', 'image/png').downloadLabel)
      .toBe('Download shot.png');
    expect(imageActionsFor({ kind: 'chat-file', id: FILE_ID, route: 'inline' }, 'shot.png', 'image/png').openLabel)
      .toBe('View full size');
  });
});

describe('AuthedFileImage action-row wiring (source pin — ticket 390b6767)', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./file-link-card.tsx', import.meta.url)), 'utf8');

  it('the ready state renders the action row with both affordances', () => {
    expect(SRC).toContain('data-authed-image-actions={id}');
    expect(SRC).toContain('title={actions.downloadLabel}');
    expect(SRC).toContain('title={actions.openLabel}');
  });

  it('Download dispatches by target kind — chatFilesApi.download vs filesApi.downloadGenerated', () => {
    expect(SRC).toContain("actions.downloadApi === 'generated'");
    expect(SRC).toContain('await filesApi.downloadGenerated(target.id, actions.filename);');
    expect(SRC).toContain('await chatFilesApi.download(target.id, actions.filename);');
  });

  it('View full size reuses the same-blob lightbox (the chat-file inline route is Bearer-only — no new-tab URL)', () => {
    // The open button must NOT window.open a Bearer-only route (it would 401).
    expect(SRC).not.toContain('window.open(authedImageUrl');
    expect(SRC).toMatch(/openLabel\}[\s\S]{0,200}onClick=\{\(\) => setExpanded\(true\)\}/);
  });

  it('the busy gate + toast failure path match the FileLinkCard idiom', () => {
    expect(SRC).toContain("toast.error('Failed to download image')");
    expect(SRC).toMatch(/disabled=\{busy\} onClick=\{\(\) => void handleDownload\(\)\}/);
  });

  it('the ready state carries the fetched mime so the download filename is truthful', () => {
    expect(SRC).toContain("setState({ status: 'ready', url: objectUrl, mime: blob.type })");
  });

  it('the SSR loading placeholder is untouched (regression pin for the c6e8edda contract)', () => {
    const html = renderToStaticMarkup(
      createElement(AuthedFileImage, { target: { kind: 'chat-file', id: FILE_ID, route: 'inline' }, alt: 'diagram' }),
    );
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html).not.toContain('data-authed-image-actions');
  });
});

describe('MarkdownContent — click-to-expand images (ticket c6e8edda)', () => {
  it('an ordinary image is wrapped in a zoom button, keeping its exact img markup', () => {
    const html = render('![cat](https://example.com/cat.png)');
    expect(html).toContain('cursor-zoom-in');
    expect(html).toContain('title="Expand image: cat"');
    expect(html).toContain('aria-label="Expand image: cat"');
    // The <img> itself is byte-identical to before — classes + lazy loading untouched.
    expect(html).toContain('<img src="https://example.com/cat.png" alt="cat" loading="lazy" class="max-w-full h-auto rounded-lg my-3"');
    // Collapsed on first render — the dialog only mounts after a click.
    expect(html).not.toContain('role="dialog"');
  });

  it('an alt-less image falls back to a generic expand label', () => {
    const html = render('![](https://example.com/cat.png)');
    expect(html).toContain('aria-label="Expand image"');
  });

  it('a chat-file image keeps the authed path (loading placeholder, no eager dialog)', () => {
    const html = render(`![floor plan](/api/crossmodel/files/${FILE_ID}/inline)`);
    expect(html).toContain('data-authed-file-image="loading"');
    expect(html).not.toContain('role="dialog"');
  });
});

describe('MarkdownContent — bare image-URL link promotion (c6e8edda follow-up)', () => {
  it('a bare image-extension URL renders the expandable inline image, not a link', () => {
    const html = render('[https://example.com/chart.png](https://example.com/chart.png)');
    expect(html).toContain('<img src="https://example.com/chart.png"');
    expect(html).toContain('cursor-zoom-in');
    // A raw-URL link text is not alt text — the generic expand label applies.
    expect(html).toContain('aria-label="Expand image"');
    // No anchor remains, and no dialog mounts before a click.
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain('role="dialog"');
  });

  it('a captioned image URL promotes with the caption as alt (extension gate is case/query tolerant)', () => {
    const html = render('[Q3 chart](https://example.com/chart.PNG?size=2x)');
    expect(html).toContain('alt="Q3 chart"');
    expect(html).toContain('aria-label="Expand image: Q3 chart"');
    expect(html).toContain('<img src="https://example.com/chart.PNG?size=2x"');
  });

  it('a non-image URL stays a plain new-tab link', () => {
    const html = render('[report](https://example.com/report.pdf)');
    expect(html).toContain('<a href="https://example.com/report.pdf" target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('data-file-link-card');
  });

  it('an svg URL stays a link (scripting-capable — never promoted on an extension sniff)', () => {
    const html = render('[icon](https://example.com/icon.svg)');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain('<img');
  });

  it('an internal /crossmodel deep link keeps its same-tab navigation (never an image)', () => {
    const html = render('[open chat](/crossmodel?chatId=abc)');
    expect(html).toContain('<a href="/crossmodel?chatId=abc"');
    expect(html).not.toContain('target=');
    expect(html).not.toContain('<img');
  });
});


// ─── Ticket 6c050917: the inline audio player ───────────────────────────────

describe('isBlobPlayableAudio — the fetched-blob audio gate', () => {
  it('audio/* essences pass, parameterized/case variants included', () => {
    expect(isBlobPlayableAudio('audio/wav')).toBe(true);
    expect(isBlobPlayableAudio('audio/mpeg')).toBe(true);
    expect(isBlobPlayableAudio('audio/mp4')).toBe(true);
    expect(isBlobPlayableAudio('audio/ogg')).toBe(true);
    expect(isBlobPlayableAudio('audio/flac')).toBe(true);
    expect(isBlobPlayableAudio('audio/webm')).toBe(true);
    expect(isBlobPlayableAudio('AUDIO/WAV')).toBe(true);
    expect(isBlobPlayableAudio('audio/wav; charset=utf-8')).toBe(true);
  });

  it('non-audio families are refused (image, video, pdf, text, html)', () => {
    expect(isBlobPlayableAudio('image/png')).toBe(false);
    expect(isBlobPlayableAudio('video/mp4')).toBe(false);
    expect(isBlobPlayableAudio('application/pdf')).toBe(false);
    expect(isBlobPlayableAudio('text/plain')).toBe(false);
    expect(isBlobPlayableAudio('text/html')).toBe(false);
    expect(isBlobPlayableAudio('')).toBe(false);
    expect(isBlobPlayableAudio('audio')).toBe(false); // no slash — not a type
  });
});

describe('AudioFilePlayer — SSR markup', () => {
  it('renders the reserved loading placeholder under SSR (the effect upgrades it in the browser)', () => {
    const html = renderToStaticMarkup(
      createElement(AudioFilePlayer, {
        target: { kind: 'chat-file', id: FILE_ID, route: 'inline' },
        filename: 'kokoro_af_heart_all4.wav',
      }),
    );
    expect(html).toContain('data-audio-player="loading"');
    expect(html).toContain('aria-label="Loading kokoro_af_heart_all4.wav"');
    expect(html).toContain('role="status"');
  });
});

describe('fetchChatFileBlob — audio targets fetch with auth (ticket 6c050917 extends the player to this route)', () => {
  it('a chat-file inline audio fetch resolves the blob (the player gates it on isBlobPlayableAudio)', async () => {
    const blob = { type: 'audio/wav' } as unknown as Blob;
    const fetchImpl = (async (_url: any, init?: any) => {
      expect(init?.headers?.Authorization).toBe('Bearer tok');
      return { ok: true, blob: async () => blob } as unknown as Response;
    }) as typeof fetch;
    (globalThis as any).window = { localStorage: { getItem: () => 'tok' } };
    try {
      const out = await fetchChatFileBlob(FILE_ID, 'inline', fetchImpl);
      expect(out).toBe(blob);
    } finally {
      delete (globalThis as any).window;
    }
  });
});
